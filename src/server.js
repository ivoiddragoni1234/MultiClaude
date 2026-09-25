// Local web dashboard: chat with Claude, manage accounts, strategy and memory.
// Binds to 127.0.0.1 and requires a random access token, because the chat can run shell commands.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator.js';
import { STRATEGIES, ACCOUNT_TYPES } from './accounts.js';
import { readMemory, writeMemory } from './memory.js';
import { paths } from './paths.js';

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');
const EDITABLE_SETTINGS = ['strategy', 'onAllLimited', 'switchAtUtilization', 'defaultCooldownMinutes', 'model', 'permissionMode'];

async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw new Error('Request too large');
  }
  return data ? JSON.parse(data) : {};
}

export function startServer(pool, { port = 7878, host = '127.0.0.1', token = crypto.randomBytes(18).toString('base64url'), cwd } = {}) {
  const orch = new Orchestrator(pool, { cwd });
  const clients = new Set();
  const log = [];

  const broadcast = (ev) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    if (ev.type !== 'waiting') { log.push(ev); if (log.length > 2000) log.shift(); }
    for (const res of clients) res.write(line);
  };
  const acct = (a) => a && { id: a.id, name: a.name };
  orch.on('account', ({ account }) => broadcast({ type: 'account', account: acct(account) }));
  orch.on('switch', ({ from, to }) => broadcast({ type: 'switch', from: acct(from), to: acct(to) }));
  orch.on('limited', ({ account, until, message }) => broadcast({ type: 'limited', account: acct(account), until, message }));
  orch.on('waiting', ({ until, msLeft }) => broadcast({ type: 'waiting', until, msLeft }));
  orch.on('retry', ({ attempt, delayMs }) => broadcast({ type: 'retry', attempt, delayMs }));
  orch.on('notice', (err) => broadcast({ type: 'notice', message: err.message }));
  orch.on('event', (ev) => {
    if (ev.type === 'text') broadcast({ type: 'text', text: ev.text });
    else if (ev.type === 'tool') broadcast({ type: 'tool', name: ev.name, input: ev.input, subagent: ev.subagent });
    else if (ev.type === 'session') broadcast({ type: 'session', sessionId: ev.sessionId });
  });

  const snapshot = () => {
    pool.load();
    return {
      accounts: pool.describe(),
      settings: Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, pool.settings[k]])),
      strategies: STRATEGIES,
      accountTypes: ACCOUNT_TYPES,
      sessionId: orch.sessionId,
      busy: orch.busy,
      cwd: orch.cwd,
      memoryPath: paths.memory,
    };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(fs.readFileSync(INDEX));
        return;
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const given = req.headers['x-token'] || url.searchParams.get('token');
      const ok = typeof given === 'string' && given.length === token.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
      if (!ok) return send(401, { error: 'Missing or wrong access token' });

      const route = `${req.method} ${url.pathname}`;
      const idMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)(?:\/(\w+))?$/);

      if (route === 'GET /api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        for (const ev of log) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (route === 'GET /api/state') return send(200, snapshot());
      if (route === 'POST /api/chat') {
        const { prompt } = await body(req);
        if (!prompt?.trim()) return send(400, { error: 'Empty message' });
        if (orch.busy) return send(409, { error: 'Claude is still working on the last message' });
        broadcast({ type: 'user', text: prompt });
        orch.send(prompt)
          .then((r) => broadcast({ type: 'done', aborted: Boolean(r.aborted), account: acct(r.account) }))
          .catch((err) => broadcast({ type: 'done', error: err.message === 'aborted' ? 'Cancelled' : err.message }));
        return send(202, { ok: true });
      }
      if (route === 'POST /api/stop') { orch.stop(); return send(200, { ok: true }); }
      if (route === 'POST /api/new') {
        if (orch.busy) return send(409, { error: 'Stop the current turn first' });
        orch.newConversation();
        log.length = 0;
        broadcast({ type: 'reset' });
        return send(200, { ok: true });
      }
      if (route === 'POST /api/accounts') {
        const { name, type, secret } = await body(req);
        pool.load();
        const a = pool.add({ name, type, secret: secret?.trim() });
        return send(201, { id: a.id, note: type === 'login' ? `Now sign in: multiclaude login ${a.id}` : undefined });
      }
      if (idMatch && req.method === 'DELETE' && !idMatch[2]) { pool.load(); pool.remove(idMatch[1]); return send(200, { ok: true }); }
      if (idMatch && req.method === 'POST') {
        pool.load();
        const [, id, action] = idMatch;
        if (action === 'use') pool.setActive(id);
        else if (action === 'enable') pool.setEnabled(id, true);
        else if (action === 'disable') pool.setEnabled(id, false, 'disabled by you');
        else if (action === 'reset') pool.clearLimit(id);
        else return send(404, { error: 'Unknown action' });
        return send(200, { ok: true });
      }
      if (route === 'POST /api/settings') {
        const patch = await body(req);
        pool.load();
        for (const k of EDITABLE_SETTINGS) {
          if (!(k in patch)) continue;
          let v = patch[k];
          if (k === 'strategy' && !STRATEGIES[v]) throw new Error('Unknown strategy');
          if (k === 'switchAtUtilization' || k === 'defaultCooldownMinutes') v = Number(v);
          pool.settings[k] = v;
        }
        pool.save();
        return send(200, snapshot());
      }
      if (route === 'GET /api/memory') return send(200, { text: readMemory(), path: paths.memory });
      if (route === 'POST /api/memory') { writeMemory(String((await body(req)).text ?? '')); return send(200, { ok: true }); }
      return send(404, { error: 'Not found' });
    } catch (err) {
      return send(400, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${port}/#token=${token}`, token, orch }));
  });
}
