// Local web app: a Claude Code–style interface with sessions, silent account rotation,
// account management and memory. Binds to 127.0.0.1 and requires a random access token,
// because anyone who can reach it can make Claude run commands on this machine.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SessionManager } from './sessions.js';
import { STRATEGIES, ACCOUNT_TYPES } from './accounts.js';
import { readMemory, writeMemory } from './memory.js';
import { paths } from './paths.js';
import { indexHtml } from './web-asset.js';
import { resolveClaude, INSTALL_HINT } from './claude-path.js';
import { openTerminal } from './desktop.js';
import { listConversations } from './transcript.js';
import { remember } from './memory.js';
import { VERSION } from './version.js';
const EDITABLE_SETTINGS = [
  'strategy', 'onAllLimited', 'switchAtUtilization', 'defaultCooldownMinutes',
  'model', 'effort', 'permissionMode', 'notifySwitches',
];
const NUMERIC = new Set(['switchAtUtilization', 'defaultCooldownMinutes']);

async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 2e6) throw new Error('Request too large');
  }
  return data ? JSON.parse(data) : {};
}

function listDirs(dir) {
  const target = path.resolve(dir || os.homedir());
  const entries = fs.readdirSync(target, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && !e.name.startsWith('$'))
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 300);
  return { path: target, parent: path.dirname(target), dirs: entries, sep: path.sep };
}

export function startServer(pool, { port = 7878, host = '127.0.0.1', token = crypto.randomBytes(18).toString('base64url'), cwd, onQuit } = {}) {
  const sessions = new SessionManager(pool, { defaultCwd: cwd || process.cwd() });
  const globalClients = new Set();
  const ping = () => { for (const res of globalClients) res.write('data: {"type":"changed"}\n\n'); };
  sessions.on('changed', ping);

  const snapshot = () => {
    pool.load();
    const claude = resolveClaude(pool.settings.claudePath);
    return {
      version: VERSION,
      claude: { found: claude.found, path: claude.path, installHint: INSTALL_HINT },
      platform: process.platform,
      accounts: pool.describe(),
      settings: Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, pool.settings[k]])),
      strategies: STRATEGIES,
      accountTypes: ACCOUNT_TYPES,
      sessions: sessions.list(),
      defaultCwd: sessions.defaultCwd,
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
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        });
        res.end(indexHtml());
        return;
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

      const given = req.headers['x-token'] || url.searchParams.get('token');
      const ok = typeof given === 'string' && given.length === token.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
      if (!ok) return send(401, { error: 'Missing or wrong access token' });

      const { pathname } = url;
      const m = req.method;
      let match;

      if (m === 'GET' && pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('data: {"type":"hello"}\n\n');
        globalClients.add(res);
        req.on('close', () => globalClients.delete(res));
        return;
      }
      if (m === 'GET' && pathname === '/api/state') return send(200, snapshot());
      if (m === 'GET' && pathname === '/api/dirs') return send(200, listDirs(url.searchParams.get('path')));

      // sessions
      if (m === 'POST' && pathname === '/api/sessions') return send(201, sessions.create(await body(req)));
      if (m === 'POST' && pathname === '/api/sessions/resume') return send(200, sessions.resume(await body(req)));
      if (m === 'GET' && pathname === '/api/conversations') {
        const open = new Map(sessions.meta.filter((x) => x.claudeSessionId).map((x) => [x.claudeSessionId, x.id]));
        return send(200, { conversations: listConversations().map((c) => ({ ...c, sessionId: open.get(c.id) || null })) });
      }
      if ((match = pathname.match(/^\/api\/sessions\/([\w-]+)\/subagents(?:\/([\w-]+)(?:\/(\w+))?)?$/))) {
        const [, id, sub, action] = match;
        if (m === 'GET' && !sub) return send(200, { subagents: sessions.subagents(id) });
        if (m === 'GET' && action === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          const unsubscribe = sessions.subscribeSubagent(id, sub, res);
          req.on('close', unsubscribe);
          return;
        }
        if (m === 'DELETE' && sub && !action) return send(200, { deleted: sessions.deleteSubagent(id, sub) });
        if (m === 'POST' && action === 'remember') return send(200, { saved: sessions.rememberSubagent(id, sub) });
        return send(404, { error: 'Not found' });
      }
      if ((match = pathname.match(/^\/api\/sessions\/([\w-]+)\/permissions\/([\w-]+)$/)) && m === 'POST') {
        const { decision } = await body(req);
        if (!['allow', 'always', 'deny'].includes(decision)) return send(400, { error: 'decision must be allow, always or deny' });
        sessions.answerPermission(match[1], match[2], decision);
        return send(200, { ok: true });
      }
      if ((match = pathname.match(/^\/api\/sessions\/([\w-]+)(?:\/(\w+))?$/))) {
        const [, id, action] = match;
        if (m === 'GET' && action === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          const unsubscribe = sessions.subscribe(id, res);
          req.on('close', unsubscribe);
          return;
        }
        if (m === 'POST' && action === 'messages') {
          const { prompt, model, effort, permissionMode } = await body(req);
          if (!prompt?.trim()) return send(400, { error: 'Empty message' });
          sessions.send(id, prompt, { model, effort, permissionMode });
          return send(202, { ok: true });
        }
        if (m === 'POST' && action === 'stop') { sessions.stop(id); return send(200, { ok: true }); }
        if (m === 'PATCH' && !action) return send(200, sessions.update(id, await body(req)));
        if (m === 'DELETE' && !action) { sessions.remove(id); return send(200, { ok: true }); }
      }

      // Interactive Claude Code sign-in flows, opened in a visible terminal window
      if (m === 'POST' && pathname === '/api/setup-token') {
        // A throwaway profile, so setup-token signs in fresh instead of reusing another account
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclaude-token-'));
        const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
        for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
        openTerminal(pool.settings.claudePath, ['setup-token'], env);
        return send(200, { ok: true });
      }

      // accounts
      if (m === 'POST' && pathname === '/api/accounts') {
        const { name, type, secret } = await body(req);
        pool.load();
        const a = pool.add({ name, type, secret: secret?.trim() });
        ping();
        return send(201, { id: a.id });
      }
      if ((match = pathname.match(/^\/api\/accounts\/([^/]+)(?:\/(\w+))?$/))) {
        const [, id, action] = match;
        pool.load();
        if (m === 'DELETE' && !action) pool.remove(id);
        else if (m === 'POST' && action === 'use') pool.setActive(id);
        else if (m === 'POST' && action === 'enable') pool.setEnabled(id, true);
        else if (m === 'POST' && action === 'disable') pool.setEnabled(id, false, 'disabled by you');
        else if (m === 'POST' && action === 'reset') pool.clearLimit(id);
        else if (m === 'POST' && action === 'login') {
          const a = pool.find(id);
          if (!a) return send(404, { error: 'No such account' });
          openTerminal(pool.settings.claudePath, ['auth', 'login'], pool.envFor(a));
        }
        else return send(404, { error: 'Unknown action' });
        ping();
        return send(200, { ok: true });
      }

      if (m === 'POST' && pathname === '/api/settings') {
        const patch = await body(req);
        pool.load();
        for (const k of EDITABLE_SETTINGS) {
          if (!(k in patch)) continue;
          let v = patch[k];
          if (k === 'strategy' && !STRATEGIES[v]) throw new Error('Unknown strategy');
          if (NUMERIC.has(k)) v = Number(v);
          if (k === 'notifySwitches') v = v === true || v === 'true';
          pool.settings[k] = v;
        }
        pool.save();
        ping();
        return send(200, snapshot());
      }
      if (m === 'POST' && pathname === '/api/memory/append') return send(200, { saved: remember(String((await body(req)).note || '')) });
      if (m === 'POST' && pathname === '/api/quit') {
        send(200, { ok: true });
        setTimeout(() => { sessions.closeAll(); (onQuit || (() => process.exit(0)))(); }, 200);
        return;
      }
      if (m === 'GET' && pathname === '/api/memory') return send(200, { text: readMemory(), path: paths.memory });
      if (m === 'POST' && pathname === '/api/memory') { writeMemory(String((await body(req)).text ?? '')); return send(200, { ok: true }); }
      return send(404, { error: 'Not found' });
    } catch (err) {
      return send(err.status || 400, { error: err.message });
    }
  });

  // Keep SSE connections alive through proxies and sleeping laptops.
  const keepAlive = setInterval(() => { for (const res of globalClients) res.write(': ping\n\n'); }, 25000);
  server.on('close', () => clearInterval(keepAlive));

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      sessions.bridge = { url: `http://${host}:${server.address().port}`, token };
      resolve({
        server,
        url: `http://${host}:${server.address().port}/#token=${token}`,
        token,
        sessions,
        // how many UI windows are connected, and whether Claude is mid-task (used to exit when idle)
        activity: () => ({ windows: globalClients.size, busy: sessions.activity().busy }),
      });
    });
  });
}
