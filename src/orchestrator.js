import { EventEmitter } from 'node:events';
import { runTurn } from './runner.js';
import { MODEL_WINDOWS, limitLabel, modelFamily } from './limits.js';

export const CONTINUE_PROMPT =
  'Your previous turn was cut off because the account running it hit a usage limit. ' +
  'You are now on a different account with the same conversation. Continue exactly where you left off ' +
  'and finish the original request. Do not repeat work that is already done, and do not mention the interruption.';

export const isContinuePrompt = (text) => typeof text === 'string' && text.startsWith(CONTINUE_PROMPT.slice(0, 60));

const MAX_OVERLOAD_RETRIES = 5;

/** Sleep that can be cut short by an AbortSignal; ticks once a second for countdowns. */
export function waitUntil(until, { signal, onTick } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const tick = () => {
      const left = until - Date.now();
      if (left <= 0) { cleanup(); resolve(); return; }
      onTick?.(left);
    };
    const timer = setInterval(tick, 1000);
    const onAbort = () => { cleanup(); reject(new Error('aborted')); };
    const cleanup = () => { clearInterval(timer); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
    tick();
  });
}

/**
 * Drives one ongoing conversation across the account pool.
 * Emits: 'account' {account, reason}, 'switch' {from, to, reason}, 'limited' {account, until, message},
 *        'waiting' {until, msLeft}, 'retry' {account, attempt, delayMs}, 'event' (runner events),
 *        'turn' {account, text, costUsd}, 'notice' (non-fatal problems)
 */
export class Orchestrator extends EventEmitter {
  constructor(pool, { cwd = process.cwd(), sessionId = null } = {}) {
    super();
    this.pool = pool;
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.controller = null;
  }

  get busy() { return Boolean(this.controller); }

  newConversation() { this.sessionId = null; }

  stop() { this.controller?.abort(); }

  async send(prompt, overrides = {}) {
    if (this.busy) throw new Error('A turn is already running');
    if (!this.pool.accounts.length) throw new Error('No accounts yet. Add one with `multiclaude add`.');
    this.controller = new AbortController();
    const { signal } = this.controller;
    try {
      return await this.#drive(prompt, signal, overrides);
    } finally {
      this.controller = null;
    }
  }

  async #drive(originalPrompt, signal, overrides) {
    const pool = this.pool;
    let prompt = originalPrompt;
    let overloadAttempts = 0;
    let lastAccountId = null;

    for (;;) {
      pool.load(); // pick up changes made from other windows (CLI, web UI)
      const model = overrides.model || pool.settings.model;
      let account = pool.pick(Date.now(), model);

      if (!account) {
        const until = pool.blockedUntil(model);
        if (!until) throw new Error('Every account is disabled. Enable or add one to continue.');
        const modelBlock = pool.modelBlock(model);
        if (modelBlock) throw new Error(modelBlock);
        if (pool.settings.onAllLimited !== 'wait') {
          throw new Error(`All accounts are at their limit. Earliest reset: ${new Date(until).toLocaleString()}`);
        }
        const maxUntil = Date.now() + pool.settings.maxWaitHours * 36e5;
        if (until > maxUntil) throw new Error(`Earliest reset (${new Date(until).toLocaleString()}) is beyond maxWaitHours`);
        this.emit('waiting', { until, msLeft: until - Date.now() });
        await waitUntil(until + 5000, { signal, onTick: (msLeft) => this.emit('waiting', { until, msLeft }) });
        continue;
      }

      if (account.id !== pool.config.activeAccountId) {
        const from = pool.find(pool.config.activeAccountId);
        pool.setActive(account.id);
        this.emit('switch', { from, to: account, reason: 'limit' });
      }
      if (account.id !== lastAccountId) this.emit('account', { account });
      lastAccountId = account.id;

      const res = await runTurn({
        pool, account, prompt, overrides, sessionId: this.sessionId, cwd: this.cwd, signal,
        onEvent: (ev) => {
          if (ev.type === 'session') this.sessionId = ev.sessionId;
          this.emit('event', ev);
        },
      });
      if (res.sessionId) this.sessionId = res.sessionId;
      const { outcome } = res;
      const windows = res.rateLimit?.windows;

      switch (outcome.kind) {
        case 'ok': {
          pool.recordTurn(account.id, { costUsd: res.costUsd, windows });
          this.#retireIfNearlyFull(account, res.rateLimit);
          if (pool.settings.strategy === 'round-robin') {
            const next = pool.nextAvailable(account.id);
            if (next && next.id !== account.id) pool.setActive(next.id);
          }
          this.emit('turn', { account, text: res.text, costUsd: res.costUsd });
          return { text: res.text, sessionId: this.sessionId, account };
        }
        case 'aborted':
          return { text: res.text, sessionId: this.sessionId, account, aborted: true };

        case 'rate_limited': {
          const until = outcome.resetsAt || Date.now() + pool.settings.defaultCooldownMinutes * 6e4;
          pool.markLimited(account.id, until, firstLine(outcome.message), outcome.modelScope, outcome.window);
          this.emit('limited', { account, until, message: firstLine(outcome.message), modelScope: outcome.modelScope });
          // The interrupted turn is saved in the shared transcript; ask the next account to resume it.
          if (this.sessionId) prompt = CONTINUE_PROMPT;
          overloadAttempts = 0;
          continue;
        }
        case 'auth':
        case 'billing': {
          const why = outcome.kind === 'auth' ? 'authentication failed' : 'out of credit';
          pool.setEnabled(account.id, false, `${why}: ${firstLine(outcome.message)}`);
          this.emit('notice', new Error(`Disabled "${account.name}" (${why}). Re-enable it with \`multiclaude enable ${account.id}\`.`));
          if (this.sessionId) prompt = CONTINUE_PROMPT;
          continue;
        }
        case 'overloaded': {
          overloadAttempts += 1;
          if (overloadAttempts > MAX_OVERLOAD_RETRIES) throw new Error(`API overloaded: ${firstLine(outcome.message)}`);
          const delayMs = Math.min(120000, 5000 * 2 ** (overloadAttempts - 1));
          this.emit('retry', { account, attempt: overloadAttempts, delayMs });
          await waitUntil(Date.now() + delayMs, { signal });
          if (this.sessionId) prompt = CONTINUE_PROMPT;
          continue;
        }
        default:
          throw new Error(outcome.message || 'Claude Code failed');
      }
    }
  }

  /** Switch before the wall: retire an account whose window is almost used up or already rejected. */
  #retireIfNearlyFull(account, rateLimit) {
    const r = retireIfNearlyFull(this.pool, account, rateLimit);
    if (r) this.emit('limited', { account, ...r, proactive: true });
  }
}

/**
 * After a successful turn: retire an account whose usage window is almost used up (or already
 * rejected) so the next turn starts on a fresh one. Returns {until, message} when it did.
 */
export function retireIfNearlyFull(pool, account, rateLimit) {
  if (!rateLimit) return null;
  const threshold = pool.settings.switchAtUtilization;
  const canSwitch = pool.accounts.length > 1 && pool.settings.strategy !== 'wait';
  // Account-wide windows retire the account; model windows (Opus/Sonnet weekly) only that model.
  const untils = { '': null };
  const bump = (scope, t) => { if (t && t > Date.now()) untils[scope] = Math.max(untils[scope] || 0, t); };
  if (rateLimit.rejected) bump(rateLimit.modelScope || '', rateLimit.resetsAt);
  if (canSwitch && threshold < 1) {
    for (const [name, w] of Object.entries(rateLimit.windows || {})) {
      if (w.utilization != null && w.utilization >= threshold) bump(MODEL_WINDOWS[name] || '', w.resetsAt);
    }
  }
  let result = null;
  for (const [scope, until] of Object.entries(untils)) {
    if (!until) continue;
    const message = rateLimit.rejected && (rateLimit.modelScope || '') === scope
      ? limitLabel(rateLimit)
      : scope ? `${scope} window nearly full, switching early` : 'window nearly full, switching early';
    const window = rateLimit.rejected && (rateLimit.modelScope || '') === scope ? rateLimit.type : null;
    pool.markLimited(account.id, until, message, scope || null, window);
    if (!result || !scope) result = { until, message, modelScope: scope || null };
  }
  return result;
}

export function firstLine(s) {
  const line = String(s || '').split('\n').find((l) => l.trim())?.trim() || '';
  return line.replace(/\|\s*\d{10,13}\b/, '').slice(0, 300);
}
