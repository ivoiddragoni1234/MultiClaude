// Conversations for the web app. Each one owns a LiveSession (a long-running Claude Code process
// that moves between accounts on its own). Subagent activity is routed into separate subagent
// conversations so it doesn't flood the main chat.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LiveSession } from './live.js';
import { loadHistory, listSubagentFiles, loadSubagentHistory, deleteSubagentFiles, findTranscript } from './transcript.js';
import { remember } from './memory.js';
import { paths } from './paths.js';
import { readJson, writeJson } from './store.js';
import { mcpCommand } from './mcp-launch.js';

const sessionsFile = () => path.join(paths.home, 'sessions.json');
const MAX_LOG = 5000;

function sse(res, ev) { res.write(`data: ${JSON.stringify(ev)}\n\n`); }

export class SessionManager extends EventEmitter {
  constructor(pool, { defaultCwd = process.cwd() } = {}) {
    super();
    this.pool = pool;
    this.defaultCwd = defaultCwd;
    this.meta = readJson(sessionsFile(), { sessions: [] }).sessions;
    this.live = new Map(); // id -> { ls, log, clients, loaded, subs: Map(subId -> {log, clients, loaded}) }
    this.bridge = null; // { url, token } of the local server, for the MCP tools
  }

  #save() { writeJson(sessionsFile(), { sessions: this.meta }); }

  get(id) {
    const m = this.meta.find((s) => s.id === id);
    if (!m) throw Object.assign(new Error('No such session'), { status: 404 });
    return m;
  }

  /** Subagents of a session: live ones merged with those recorded on disk, minus deleted ones. */
  subagents(id) {
    const m = this.get(id);
    const hidden = new Set(m.hiddenSubagents || []);
    const byId = new Map();
    if (m.claudeSessionId) {
      for (const d of listSubagentFiles(m.claudeSessionId)) {
        byId.set(d.id, { id: d.id, agentId: d.agentId, description: d.description, type: d.type, status: 'done', file: d.file, startedAt: d.mtime });
      }
    }
    for (const s of this.live.get(id)?.ls.subagents.values() || []) {
      const prev = byId.get(s.id) || [...byId.values()].find((x) => x.agentId && x.agentId === s.agentId);
      if (prev) byId.delete(prev.id);
      byId.set(s.id, { ...prev, ...s, file: prev?.file });
    }
    return [...byId.values()]
      .filter((s) => !hidden.has(s.id) && !(s.agentId && hidden.has(s.agentId)))
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
      .map(({ file, prompt, ...rest }) => rest);
  }

  list() {
    return [...this.meta]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => {
        const l = this.live.get(m.id);
        let subagents = [];
        try { subagents = this.subagents(m.id); } catch { /* transcript missing */ }
        return {
          id: m.id, title: m.title, cwd: m.cwd, claudeSessionId: m.claudeSessionId, createdAt: m.createdAt, updatedAt: m.updatedAt,
          busy: Boolean(l?.ls.working),
          subagents,
        };
      });
  }

  create({ cwd, title, claudeSessionId = null } = {}) {
    let dir = path.resolve(cwd || this.defaultCwd);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      if (claudeSessionId) dir = this.defaultCwd; // resumed conversation whose folder is gone
      else throw new Error(`Folder not found: ${dir}`);
    }
    const m = { id: crypto.randomUUID(), title: title || 'New session', cwd: dir, claudeSessionId, createdAt: Date.now(), updatedAt: Date.now() };
    this.meta.push(m);
    this.#save();
    this.emit('changed');
    return m;
  }

  /** Open a Claude Code conversation (from /resume) as a MultiClaude session, reusing one if it exists. */
  resume({ claudeSessionId, cwd, title }) {
    if (!findTranscript(claudeSessionId)) throw Object.assign(new Error('That conversation no longer exists'), { status: 404 });
    const existing = this.meta.find((s) => s.claudeSessionId === claudeSessionId);
    if (existing) return existing;
    return this.create({ cwd, title: title || 'Resumed conversation', claudeSessionId });
  }

  update(id, patch) {
    const m = this.get(id);
    if (typeof patch.title === 'string' && patch.title.trim()) m.title = patch.title.trim().slice(0, 120);
    this.#save();
    this.emit('changed');
    return m;
  }

  remove(id) {
    const m = this.get(id);
    const l = this.live.get(id);
    l?.ls.close();
    this.live.delete(id);
    this.meta = this.meta.filter((s) => s !== m);
    this.#save();
    this.emit('changed');
  }

  closeAll() {
    for (const l of this.live.values()) l.ls.close();
  }

  activity() {
    return { busy: [...this.live.values()].some((l) => l.ls.working || l.ls.backgroundTasks > 0) };
  }

  #liveFor(id) {
    let l = this.live.get(id);
    if (l) return l;
    const m = this.get(id);
    const mcp = this.bridge
      ? { ...mcpCommand(), env: { MULTICLAUDE_URL: this.bridge.url, MULTICLAUDE_TOKEN: this.bridge.token, MULTICLAUDE_SESSION: id } }
      : null;
    const ls = new LiveSession(this.pool, { cwd: m.cwd, sessionId: m.claudeSessionId, mcp });
    l = { ls, log: [], clients: new Set(), loaded: false, subs: new Map() };
    this.live.set(id, l);

    const push = (ev) => this.#push(id, ev);
    const acct = (a) => a && { id: a.id, name: a.name };
    ls.on('account', ({ account }) => push({ type: 'account', account: acct(account) }));
    ls.on('switch', ({ from, to }) => push({ type: 'switch', from: acct(from), to: acct(to) }));
    ls.on('limited', ({ account, until, message }) => push({ type: 'limited', account: acct(account), until, message }));
    ls.on('waiting', ({ until, msLeft }) => push({ type: 'waiting', until, msLeft, transient: true }));
    ls.on('retry', ({ attempt, delayMs }) => push({ type: 'retry', attempt, delayMs }));
    ls.on('notice', (err) => push({ type: 'notice', message: err.message }));
    ls.on('busy', (busy) => {
      push({ type: 'busy', busy, transient: true });
      m.updatedAt = Date.now();
      this.#save();
      this.emit('changed');
    });
    ls.on('turn_end', ({ aborted, error }) => push({ type: 'done', aborted: Boolean(aborted), error }));
    ls.on('event', (ev) => {
      if (ev.type === 'session') {
        m.claudeSessionId = ev.sessionId;
        this.#save();
        return;
      }
      if (ev.type === 'subagent') {
        const { prompt, ...s } = ev.subagent;
        push({ type: 'subagent', subagent: s });
        this.emit('changed');
        return;
      }
      if (ev.parentId) { this.#pushSub(id, ev.parentId, ev); return; }
      push(ev);
    });
    return l;
  }

  #push(id, ev) {
    const l = this.live.get(id);
    if (!l) return;
    if (!ev.transient) {
      l.log.push(ev);
      if (l.log.length > MAX_LOG) l.log.splice(0, l.log.length - MAX_LOG);
    }
    for (const res of l.clients) sse(res, ev);
  }

  #subLog(id, subId) {
    const l = this.#liveFor(id);
    let sub = l.subs.get(subId);
    if (!sub) {
      sub = { log: [], clients: new Set(), loaded: false };
      l.subs.set(subId, sub);
    }
    if (!sub.loaded) {
      sub.loaded = true;
      // Earlier history of this subagent from disk (e.g. after an app restart)
      const m = this.get(id);
      const disk = m.claudeSessionId && listSubagentFiles(m.claudeSessionId).find((d) => d.id === subId || d.agentId === subId);
      const live = l.ls.subagents.get(subId);
      if (live?.prompt) sub.log.push({ type: 'user', text: live.prompt });
      if (disk) {
        const events = loadSubagentHistory(disk.file);
        sub.log.push(...(live?.prompt ? events.filter((e, i) => !(i === 0 && e.type === 'user')) : events));
      }
    }
    return sub;
  }

  #pushSub(id, subId, ev) {
    const sub = this.#subLog(id, subId);
    if (ev.type === 'tool' && sub.log.some((e) => e.type === 'tool' && e.id === ev.id)) return;
    const clean = { ...ev, parentId: null };
    sub.log.push(clean);
    if (sub.log.length > MAX_LOG) sub.log.splice(0, sub.log.length - MAX_LOG);
    for (const res of sub.clients) sse(res, clean);
  }

  /** Stream a session's history then live events to an SSE response. */
  subscribe(id, res) {
    const l = this.#liveFor(id);
    const m = this.get(id);
    if (!l.loaded) {
      l.loaded = true;
      if (!l.log.length && m.claudeSessionId) l.log.unshift(...loadHistory(m.claudeSessionId));
    }
    for (const ev of l.log) sse(res, { ...ev, replay: true });
    for (const p of l.ls.pendingPermissions()) sse(res, { type: 'permission', ...p, replay: true });
    sse(res, { type: 'ready', busy: l.ls.working, subagents: this.subagents(id) });
    l.clients.add(res);
    return () => l.clients.delete(res);
  }

  subscribeSubagent(id, subId, res) {
    const s = this.subagents(id).find((x) => x.id === subId || x.agentId === subId);
    if (!s) throw Object.assign(new Error('No such subagent'), { status: 404 });
    const sub = this.#subLog(id, s.id);
    for (const ev of sub.log) sse(res, { ...ev, replay: true });
    sse(res, { type: 'ready', subagent: s, busy: s.status === 'running' });
    sub.clients.add(res);
    return () => sub.clients.delete(res);
  }

  send(id, prompt, overrides = {}) {
    const l = this.#liveFor(id);
    const m = this.get(id);
    if (!l.loaded) {
      l.loaded = true;
      if (m.claudeSessionId) l.log.unshift(...loadHistory(m.claudeSessionId));
    }
    if (m.title === 'New session') m.title = prompt.trim().replace(/\s+/g, ' ').slice(0, 60);
    m.updatedAt = Date.now();
    this.#save();
    this.#push(id, { type: 'user', text: prompt, midTurn: l.ls.busy });
    this.emit('changed');
    l.ls.send(prompt, overrides);
  }

  stop(id) { this.live.get(id)?.ls.stop(); }

  answerPermission(id, requestId, decision) {
    const l = this.live.get(id);
    if (!l || !l.ls.answerPermission(requestId, decision)) throw Object.assign(new Error('That request is no longer pending'), { status: 404 });
  }

  deleteSubagent(id, ref) {
    const m = this.get(id);
    const s = this.subagents(id).find((x) => x.id === ref || x.agentId === ref);
    if (!s) throw Object.assign(new Error(`No subagent "${ref}"`), { status: 404 });
    if (s.status === 'running') throw Object.assign(new Error('That subagent is still running'), { status: 409 });
    const disk = m.claudeSessionId && listSubagentFiles(m.claudeSessionId).find((d) => d.id === s.id || d.agentId === s.agentId);
    if (disk) deleteSubagentFiles(disk.file);
    m.hiddenSubagents = [...new Set([...(m.hiddenSubagents || []), s.id, ...(s.agentId ? [s.agentId] : [])])];
    this.live.get(id)?.ls.subagents.delete(s.id);
    this.live.get(id)?.subs.delete(s.id);
    this.#save();
    this.#push(id, { type: 'subagent_deleted', id: s.id });
    this.emit('changed');
    return s;
  }

  /** Save a subagent's final report to long-term memory. */
  rememberSubagent(id, ref) {
    const s = this.subagents(id).find((x) => x.id === ref || x.agentId === ref);
    if (!s) throw Object.assign(new Error(`No subagent "${ref}"`), { status: 404 });
    const sub = this.#subLog(id, s.id);
    const lastText = [...sub.log].reverse().find((e) => e.type === 'text')?.text;
    const report = (s.summary || lastText || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (!report) throw new Error('This subagent has no report to save yet');
    return remember(`Subagent "${s.description}": ${report}`);
  }
}
