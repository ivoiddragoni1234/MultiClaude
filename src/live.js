// One long-running Claude Code process per conversation, driven over stream-json. This is what
// the Claude Code app does: you can send messages while Claude works (they are absorbed into the
// running turn), subagents and background tasks keep going between turns, permission prompts are
// answered by the UI, and Stop interrupts the turn without losing the session.
//
// When the account behind the process runs out, the process is replaced by one on the next
// account that resumes the same session, and the work continues.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { classifyOutcome, readRateLimitEvent, mergeRateLimit } from './limits.js';
import { memoryPrompt } from './memory.js';
import { claudeSpawn, claudeSupports, INSTALL_HINT } from './claude-path.js';
import { CONTINUE_PROMPT, retireIfNearlyFull, firstLine, waitUntil } from './orchestrator.js';

const isWin = process.platform === 'win32';
const STOP_GRACE_MS = 4000;
const IDLE_CLOSE_MS = 20 * 60 * 1000;
const MAX_OVERLOAD_RETRIES = 5;
const AGENT_TOOLS = new Set(['Agent', 'Task']);

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    else process.kill(-child.pid, 'SIGKILL'); // whole process group: Claude plus its shells and tools
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function toText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
}
const clip = (s, n = 8000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

function sameOpts(a, b) {
  return a && b && a.model === b.model && a.effort === b.effort && a.permissionMode === b.permissionMode;
}

export const SUBAGENT_GUIDANCE =
  'Subagents you start are shown to the user as separate conversations in a sidebar, not in the main chat. ' +
  'You can resume a finished subagent with SendMessage. When a subagent is finished and you will not need it again, ' +
  'save anything worth keeping with the mcp__multiclaude__remember tool, then remove it with mcp__multiclaude__subagent_delete ' +
  '(use mcp__multiclaude__subagents_list to see them). Keep subagents you may still resume.';

/**
 * Events: 'event' (UI events: text, tool, tool_result, session, compact, permission, permission_done,
 *   subagent, tasks), 'busy' (boolean), 'account', 'switch', 'limited', 'waiting', 'retry', 'notice',
 *   'turn_end' {aborted?, error?}
 */
export class LiveSession extends EventEmitter {
  constructor(pool, { cwd, sessionId = null, mcp = null } = {}) {
    super();
    this.pool = pool;
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.mcp = mcp; // { command, args, env } for the MultiClaude MCP server, or null
    this.proc = null;
    this.account = null;
    this.opts = null;
    this.busy = false;
    this.interrupting = null;
    this.inflight = [];
    this.permissions = new Map(); // requestId -> request
    this.controls = new Map(); // our control requests awaiting a response
    this.subagents = new Map(); // Agent tool_use id -> { id, agentId, description, type, status }
    this.backgroundTasks = 0;
    this.rateLimit = null;
    this.waitController = null;
    this.starting = null;
    this.overloadAttempts = 0;
    this.lastActivity = Date.now();
    this.idleTimer = setInterval(() => this.#closeIfIdle(), 60000);
    this.idleTimer.unref?.();
  }

  /** True while Claude is working on something the user should wait for or could stop. */
  get working() {
    return this.busy || Boolean(this.starting) || [...this.subagents.values()].some((s) => s.status === 'running');
  }

  #setBusy(b) {
    if (this.busy === b) return;
    this.busy = b;
    this.lastActivity = Date.now();
    this.emit('busy', b);
  }

  /** Send a user message. Works while Claude is busy: it's absorbed into the running turn. */
  async send(text, overrides = {}) {
    this.lastActivity = Date.now();
    const midTurn = this.busy && Boolean(this.proc);
    if (!midTurn) this.rateLimit = null; // a fresh turn: judge it by its own limit events only
    this.inflight.push(text);
    this.#setBusy(true);
    try {
      await this.#ensureProcess(overrides, midTurn);
    } catch (err) {
      if (!this.busy) return; // several messages were waiting on the same start; report once
      this.inflight = [];
      this.#setBusy(false);
      if (err.message === 'aborted') { this.emit('turn_end', { aborted: true }); return; }
      this.emit('turn_end', { error: err.message });
      return;
    }
    this.#write({ type: 'user', message: { role: 'user', content: text } });
  }

  /** Stop the current turn. A second press, or no response within a few seconds, kills the process tree. */
  stop() {
    if (this.waitController) { this.waitController.abort(); return; }
    if (!this.proc) { this.inflight = []; this.#setBusy(false); return; }
    if (this.interrupting) { this.#hardStop(); return; }
    for (const id of [...this.permissions.keys()]) this.answerPermission(id, 'deny', 'The user pressed Stop.');
    const requestId = crypto.randomUUID();
    this.#write({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
    this.interrupting = setTimeout(() => this.#hardStop(), STOP_GRACE_MS);
  }

  #hardStop() {
    clearTimeout(this.interrupting);
    this.interrupting = null;
    const proc = this.proc;
    this.proc = null;
    killTree(proc);
    for (const s of this.subagents.values()) if (s.status === 'running') this.#subagentStatus(s, 'stopped');
    this.#clearPermissions();
    this.inflight = [];
    this.backgroundTasks = 0;
    this.emit('event', { type: 'tasks', running: 0 });
    this.#setBusy(false);
    this.emit('turn_end', { aborted: true });
  }

  answerPermission(requestId, decision, message) {
    const req = this.permissions.get(requestId);
    if (!req) return false;
    this.permissions.delete(requestId);
    let response;
    if (decision === 'allow' || decision === 'always') {
      response = { behavior: 'allow', updatedInput: req.input };
      if (decision === 'always' && req.suggestions?.length) response.updatedPermissions = req.suggestions;
    } else {
      response = { behavior: 'deny', message: message || 'The user denied this action.' };
    }
    this.#write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emit('event', { type: 'permission_done', requestId, decision });
    return true;
  }

  pendingPermissions() { return [...this.permissions.values()]; }

  close() {
    clearInterval(this.idleTimer);
    this.waitController?.abort();
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try { proc.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => killTree(proc), 3000).unref?.();
  }

  #closeIfIdle() {
    if (this.proc && !this.working && this.backgroundTasks === 0 && Date.now() - this.lastActivity > IDLE_CLOSE_MS) this.close();
  }

  #clearPermissions() {
    for (const id of this.permissions.keys()) this.emit('event', { type: 'permission_done', requestId: id, decision: 'cancelled' });
    this.permissions.clear();
  }

  #write(obj) {
    try { this.proc?.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* process is gone; exit handler deals with it */ }
  }

  #options(overrides) {
    const s = this.pool.settings;
    const pick = (k) => (overrides[k] != null && overrides[k] !== '' ? overrides[k] : s[k] || '');
    return { model: pick('model'), effort: pick('effort'), permissionMode: pick('permissionMode') };
  }

  async #ensureProcess(overrides, midTurn) {
    if (this.starting) { await this.starting; }
    const opts = this.#options(overrides);
    this.pool.load();
    if (this.proc) {
      const accountOk = this.account && this.pool.find(this.account.id) && this.pool.isAvailable(this.pool.find(this.account.id), Date.now(), opts.model);
      if (accountOk && sameOpts(opts, this.opts)) return;
      // Settings changed or the account was retired: restart between turns, never mid-turn.
      if (midTurn) {
        if (!sameOpts(opts, this.opts)) this.#applyLive(opts);
        return;
      }
      const old = this.proc;
      this.proc = null;
      try { old.stdin.end(); } catch { /* ignore */ }
      setTimeout(() => killTree(old), 3000).unref?.();
    }
    this.starting = this.#start(opts).finally(() => { this.starting = null; });
    await this.starting;
  }

  /** Change model / permission mode on a running process without restarting it. */
  #applyLive(opts) {
    if (opts.model !== this.opts.model && opts.model) {
      this.#write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'set_model', model: opts.model === 'default' ? undefined : opts.model } });
    }
    if (opts.permissionMode !== this.opts.permissionMode && opts.permissionMode) {
      this.#write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'set_permission_mode', mode: opts.permissionMode } });
    }
    this.opts = { ...this.opts, model: opts.model, permissionMode: opts.permissionMode };
  }

  #args(opts) {
    const s = this.pool.settings;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (claudeSupports(s.claudePath, '--permission-prompt-tool')) args.push('--permission-prompt-tool', 'stdio');
    if (claudeSupports(s.claudePath, '--forward-subagent-text')) args.push('--forward-subagent-text');
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (opts.model && opts.model !== 'default') args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    if (opts.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
    else if (opts.permissionMode && opts.permissionMode !== 'default') args.push('--permission-mode', opts.permissionMode);
    let prompt = memoryPrompt();
    if (this.mcp) {
      args.push('--mcp-config', JSON.stringify({ mcpServers: { multiclaude: { type: 'stdio', ...this.mcp } } }));
      args.push('--allowedTools', 'mcp__multiclaude');
      prompt += ` ${SUBAGENT_GUIDANCE}`;
    }
    args.push('--append-system-prompt', prompt);
    args.push(...(s.extraArgs || []));
    return args;
  }

  /** Start Claude Code on the best available account (waiting for a reset if all are used up). */
  async #start(opts) {
    const pool = this.pool;
    for (;;) {
      pool.load();
      if (!pool.accounts.length) throw new Error('No accounts yet. Open Accounts to add one.');
      const account = pool.pick(Date.now(), opts.model);
      if (account) {
        if (account.id !== pool.config.activeAccountId) {
          const from = pool.find(pool.config.activeAccountId);
          pool.setActive(account.id);
          this.emit('switch', { from, to: account });
        }
        this.#spawn(account, opts);
        return;
      }
      const until = pool.blockedUntil(opts.model);
      if (!until) throw new Error('Every account is paused or disabled. Enable one in Accounts.');
      const modelBlock = pool.modelBlock(opts.model);
      if (modelBlock) throw new Error(modelBlock);
      if (pool.settings.onAllLimited !== 'wait') throw new Error(`All accounts are at their limit. Earliest reset: ${new Date(until).toLocaleString()}`);
      this.waitController = new AbortController();
      this.emit('waiting', { until, msLeft: until - Date.now() });
      try {
        await waitUntil(until + 5000, { signal: this.waitController.signal, onTick: (msLeft) => this.emit('waiting', { until, msLeft }) });
      } finally {
        this.waitController = null;
      }
    }
  }

  #spawn(account, opts) {
    const s = this.pool.settings;
    const sp = claudeSpawn(s.claudePath, this.#args(opts));
    const child = spawn(sp.command, sp.args, {
      ...sp.options,
      cwd: this.cwd,
      env: this.pool.envFor(account),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWin, // own process group so Stop can kill every tool it started
    });
    this.proc = child;
    this.account = account;
    this.opts = opts;
    this.rateLimit = null;
    let stderr = '';
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20000); });
    child.on('error', (err) => {
      if (this.proc !== child) return;
      this.proc = null;
      const msg = err.code === 'ENOENT' ? `Could not find Claude Code. ${INSTALL_HINT}` : err.message;
      this.inflight = [];
      this.#setBusy(false);
      this.emit('turn_end', { error: msg });
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (this.proc !== child) return; // output from a process we already replaced
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      this.#onMessage(msg);
    });
    child.on('exit', (code) => {
      if (this.proc !== child) return;
      this.proc = null;
      this.#clearPermissions();
      if (!this.busy) return;
      // Died mid-turn: maybe the account ran out (reported on stderr), maybe a crash.
      const outcome = classifyOutcome({ result: null, rateLimit: this.rateLimit, stderr, exitCode: code ?? 1 });
      if (outcome.kind === 'error') {
        this.inflight = [];
        this.#setBusy(false);
        this.emit('turn_end', { error: `Claude Code stopped unexpectedly: ${firstLine(outcome.message)}` });
      } else {
        this.#failover(outcome);
      }
    });
    this.emit('account', { account });
  }

  #onMessage(msg) {
    const parentId = msg.parent_tool_use_id || null;
    if (msg.session_id && msg.session_id !== this.sessionId && (msg.type === 'system' || msg.type === 'result')) {
      this.sessionId = msg.session_id;
      this.emit('event', { type: 'session', sessionId: msg.session_id });
    }
    const topLevelActivity = !parentId && (msg.type === 'stream_event' || msg.type === 'assistant');
    if (topLevelActivity && !this.busy) this.#setBusy(true); // Claude started a turn on its own (e.g. a subagent finished)
    if (msg.type !== 'result') this.lastActivity = Date.now();

    switch (msg.type) {
      case 'stream_event': {
        const ev = msg.event;
        if (!parentId && ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.emit('event', { type: 'text', text: ev.delta.text, parentId: null });
        }
        if (!parentId && ev?.type === 'content_block_stop') this.emit('event', { type: 'text_end' });
        break;
      }
      case 'assistant':
        for (const b of msg.message?.content || []) {
          if (b.type === 'tool_use') {
            this.emit('event', { type: 'tool', id: b.id, name: b.name, input: b.input, parentId, subagent: Boolean(parentId) });
            if (!parentId && AGENT_TOOLS.has(b.name)) {
              const s = { id: b.id, agentId: null, description: b.input?.description || 'Subagent', type: b.input?.subagent_type || 'general-purpose', prompt: b.input?.prompt || '', status: 'running', startedAt: Date.now() };
              this.subagents.set(b.id, s);
              this.emit('event', { type: 'subagent', subagent: s });
            }
            if (!parentId && b.name === 'SendMessage') {
              const s = [...this.subagents.values()].find((x) => x.agentId && x.agentId === b.input?.to);
              if (s) this.#subagentStatus(s, 'running');
            }
          } else if (b.type === 'text' && parentId && b.text.trim()) {
            this.emit('event', { type: 'text', text: `${b.text}\n`, parentId, block: true }); // subagent text (forwarded)
          }
        }
        break;
      case 'user':
        for (const b of Array.isArray(msg.message?.content) ? msg.message.content : []) {
          if (b.type !== 'tool_result') continue;
          const content = toText(b.content);
          this.emit('event', { type: 'tool_result', toolUseId: b.tool_use_id, isError: Boolean(b.is_error), content: clip(content), parentId });
          const s = this.subagents.get(b.tool_use_id);
          if (s) {
            const id = content.match(/agentId:\s*([\w-]+)/);
            if (id) s.agentId = id[1];
            if (/agent launched/i.test(content)) this.emit('event', { type: 'subagent', subagent: s });
            else this.#subagentStatus(s, b.is_error ? 'failed' : 'done', content);
          }
        }
        break;
      case 'system':
        if (msg.subtype === 'compact_boundary') this.emit('event', { type: 'compact', trigger: msg.compact_metadata?.trigger || 'auto' });
        else if (msg.subtype === 'background_tasks_changed') {
          this.backgroundTasks = (msg.tasks || []).length;
          this.emit('event', { type: 'tasks', running: this.backgroundTasks });
        } else if (msg.subtype === 'task_notification' || msg.subtype === 'task_updated') {
          const s = this.subagents.get(msg.tool_use_id) || [...this.subagents.values()].find((x) => x.agentId && x.agentId === msg.task_id);
          const status = msg.status || msg.patch?.status;
          if (s && status && status !== 'running') this.#subagentStatus(s, status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'stopped', msg.summary);
        }
        break;
      case 'rate_limit_event':
        this.rateLimit = mergeRateLimit(this.rateLimit, readRateLimitEvent(msg.rate_limit_info));
        break;
      case 'control_request':
        this.#onControlRequest(msg);
        break;
      case 'result':
        this.#onResult(msg);
        break;
      default:
        break;
    }
  }

  #subagentStatus(s, status, summary) {
    if (s.status === status && !summary) return;
    s.status = status;
    if (summary) s.summary = clip(String(summary), 4000);
    if (status !== 'running') s.endedAt = Date.now();
    this.emit('event', { type: 'subagent', subagent: s });
  }

  #onControlRequest(msg) {
    const req = msg.request || {};
    if (req.subtype === 'can_use_tool') {
      const p = {
        requestId: msg.request_id,
        toolName: req.tool_name,
        displayName: req.display_name || req.tool_name,
        input: req.input,
        description: req.description || '',
        suggestions: req.permission_suggestions || [],
      };
      this.permissions.set(msg.request_id, p);
      this.emit('event', { type: 'permission', ...p });
      return;
    }
    // Anything else we don't implement: say so, so Claude Code doesn't wait forever.
    this.#write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported request: ${req.subtype}` } });
  }

  #onResult(msg) {
    const aborted = Boolean(this.interrupting);
    if (aborted) {
      clearTimeout(this.interrupting);
      this.interrupting = null;
    }
    const outcome = classifyOutcome({ result: msg, rateLimit: this.rateLimit, stderr: '', exitCode: 0 });
    if (aborted || outcome.kind === 'ok') {
      if (outcome.kind === 'ok') {
        this.overloadAttempts = 0;
        this.pool.load();
        this.pool.recordTurn(this.account.id, { costUsd: msg.total_cost_usd, windows: this.rateLimit?.windows });
        const retired = retireIfNearlyFull(this.pool, this.account, this.rateLimit);
        if (retired) this.emit('limited', { account: this.account, ...retired, proactive: true });
        if (this.pool.settings.strategy === 'round-robin') {
          const next = this.pool.nextAvailable(this.account.id, Date.now(), this.opts?.model);
          if (next && next.id !== this.account.id) this.pool.setActive(next.id);
        }
      }
      // Don't let this turn's limit events count against the next one (e.g. after "Clear limit").
      this.rateLimit = null;
      this.inflight = [];
      this.#setBusy(false);
      this.emit('turn_end', { aborted });
      return;
    }
    if (outcome.kind === 'error') {
      this.inflight = [];
      this.#setBusy(false);
      this.emit('turn_end', { error: firstLine(outcome.message) || 'Claude Code reported an error' });
      return;
    }
    this.#failover(outcome);
  }

  /** The account can't continue: retire it and resume the same session on the next one. */
  async #failover(outcome) {
    const pool = this.pool;
    const account = this.account;
    pool.load();
    if (outcome.kind === 'rate_limited') {
      const until = outcome.resetsAt || Date.now() + pool.settings.defaultCooldownMinutes * 6e4;
      pool.markLimited(account.id, until, firstLine(outcome.message), outcome.modelScope, outcome.window);
      this.emit('limited', { account, until, message: firstLine(outcome.message), modelScope: outcome.modelScope });
    } else if (outcome.kind === 'auth' || outcome.kind === 'billing') {
      const why = outcome.kind === 'auth' ? 'sign-in failed' : 'out of credit';
      pool.setEnabled(account.id, false, `${why}: ${firstLine(outcome.message)}`);
      this.emit('notice', new Error(`Paused "${account.name}" (${why}).`));
    } else if (outcome.kind === 'overloaded') {
      this.overloadAttempts += 1;
      if (this.overloadAttempts > MAX_OVERLOAD_RETRIES) {
        this.inflight = [];
        this.#setBusy(false);
        this.emit('turn_end', { error: `The API is overloaded: ${firstLine(outcome.message)}` });
        return;
      }
      const delayMs = Math.min(120000, 5000 * 2 ** (this.overloadAttempts - 1));
      this.emit('retry', { account, attempt: this.overloadAttempts, delayMs });
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const old = this.proc;
    this.proc = null;
    killTree(old);
    this.#clearPermissions();

    // Messages sent during the failed turn may not have been handled; pass them on.
    const extra = this.inflight.slice(1);
    const prompt = this.sessionId
      ? CONTINUE_PROMPT + (extra.length ? `\n\nThe user also sent these messages during that turn; make sure they are handled:\n${extra.map((t) => `- ${t}`).join('\n')}` : '')
      : this.inflight.join('\n\n');
    try {
      this.starting = this.#start(this.opts).finally(() => { this.starting = null; });
      await this.starting;
    } catch (err) {
      this.inflight = [];
      this.#setBusy(false);
      this.emit('turn_end', { error: err.message === 'aborted' ? undefined : err.message, aborted: err.message === 'aborted' });
      return;
    }
    this.#write({ type: 'user', message: { role: 'user', content: prompt } });
  }
}
