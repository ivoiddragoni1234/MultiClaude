// Multiple conversations for the web app. Each one owns an Orchestrator, so every conversation
// moves between accounts on its own, mid-turn, without the browser noticing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Orchestrator } from './orchestrator.js';
import { loadHistory } from './transcript.js';
import { paths } from './paths.js';
import { readJson, writeJson } from './store.js';

const sessionsFile = () => path.join(paths.home, 'sessions.json');
const MAX_LOG = 5000;

export class SessionManager extends EventEmitter {
  constructor(pool, { defaultCwd = process.cwd() } = {}) {
    super();
    this.pool = pool;
    this.defaultCwd = defaultCwd;
    this.meta = readJson(sessionsFile(), { sessions: [] }).sessions;
    this.live = new Map(); // id -> { orch, log, clients:Set, loaded }
  }

  #save() { writeJson(sessionsFile(), { sessions: this.meta }); }

  list() {
    return [...this.meta]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => ({ ...m, busy: Boolean(this.live.get(m.id)?.orch.busy) }));
  }

  get(id) {
    const m = this.meta.find((s) => s.id === id);
    if (!m) throw Object.assign(new Error('No such session'), { status: 404 });
    return m;
  }

  create({ cwd, title } = {}) {
    const dir = path.resolve(cwd || this.defaultCwd);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
    const m = { id: crypto.randomUUID(), title: title || 'New session', cwd: dir, claudeSessionId: null, createdAt: Date.now(), updatedAt: Date.now() };
    this.meta.push(m);
    this.#save();
    this.emit('changed');
    return m;
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
    this.live.get(id)?.orch.stop();
    this.live.delete(id);
    this.meta = this.meta.filter((s) => s !== m);
    this.#save();
    this.emit('changed');
  }

  #liveFor(id) {
    let l = this.live.get(id);
    if (l) return l;
    const m = this.get(id);
    const orch = new Orchestrator(this.pool, { cwd: m.cwd, sessionId: m.claudeSessionId });
    l = { orch, log: [], clients: new Set(), loaded: false };
    this.live.set(id, l);

    const push = (ev) => this.#push(id, ev);
    const acct = (a) => a && { id: a.id, name: a.name };
    orch.on('account', ({ account }) => push({ type: 'account', account: acct(account) }));
    orch.on('switch', ({ from, to }) => push({ type: 'switch', from: acct(from), to: acct(to) }));
    orch.on('limited', ({ account, until, message }) => push({ type: 'limited', account: acct(account), until, message }));
    orch.on('waiting', ({ until, msLeft }) => push({ type: 'waiting', until, msLeft, transient: true }));
    orch.on('retry', ({ attempt, delayMs }) => push({ type: 'retry', attempt, delayMs }));
    orch.on('notice', (err) => push({ type: 'notice', message: err.message }));
    orch.on('event', (ev) => {
      if (ev.type === 'session') {
        m.claudeSessionId = ev.sessionId;
        this.#save();
      } else if (ev.type === 'text' || ev.type === 'tool' || ev.type === 'tool_result') {
        push(ev);
      }
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
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of l.clients) res.write(line);
  }

  /** Stream a session's history then live events to an SSE response. */
  subscribe(id, res) {
    const l = this.#liveFor(id);
    const m = this.get(id);
    if (!l.loaded) {
      l.loaded = true;
      if (!l.log.length && m.claudeSessionId) l.log.push(...loadHistory(m.claudeSessionId));
    }
    for (const ev of l.log) res.write(`data: ${JSON.stringify({ ...ev, replay: true })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'ready', busy: l.orch.busy })}\n\n`);
    l.clients.add(res);
    return () => l.clients.delete(res);
  }

  send(id, prompt, overrides = {}) {
    const l = this.#liveFor(id);
    const m = this.get(id);
    if (l.orch.busy) throw Object.assign(new Error('Claude is still working in this session'), { status: 409 });
    if (!l.loaded) {
      l.loaded = true;
      if (m.claudeSessionId) l.log.push(...loadHistory(m.claudeSessionId));
    }
    if (m.title === 'New session') m.title = prompt.trim().replace(/\s+/g, ' ').slice(0, 60);
    m.updatedAt = Date.now();
    this.#save();
    this.#push(id, { type: 'user', text: prompt });
    this.#push(id, { type: 'busy', busy: true, transient: true });
    this.emit('changed');
    l.orch.send(prompt, overrides)
      .then((r) => this.#push(id, { type: 'done', aborted: Boolean(r.aborted) }))
      .catch((err) => this.#push(id, { type: 'done', error: err.message === 'aborted' ? 'Interrupted' : err.message }))
      .finally(() => {
        m.updatedAt = Date.now();
        this.#save();
        this.emit('changed');
      });
  }

  stop(id) { this.live.get(id)?.orch.stop(); }
}
