import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'multiclaude.js');

test('MCP server exposes subagent and memory tools backed by the app API', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, token: req.headers['x-token'], body });
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/subagents')) res.end(JSON.stringify({ subagents: [{ id: 't1', agentId: 'a1', status: 'done', type: 'Explore', description: 'Look' }] }));
      else res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [bin, 'mcp'], {
    env: { ...process.env, MULTICLAUDE_URL: `http://127.0.0.1:${server.address().port}`, MULTICLAUDE_TOKEN: 'tok', MULTICLAUDE_SESSION: 's1' },
  });
  const replies = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); replies.get(m.id)?.(m); });
  const rpc = (id, method, params) => new Promise((resolve) => { replies.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });

  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(init.result.serverInfo.name, 'multiclaude');
  const tools = await rpc(2, 'tools/list', {});
  assert.deepEqual(tools.result.tools.map((t) => t.name), ['subagents_list', 'subagent_delete', 'remember']);
  const list = await rpc(3, 'tools/call', { name: 'subagents_list', arguments: {} });
  assert.match(list.result.content[0].text, /a1 \[done\] Explore: Look/);
  await rpc(4, 'tools/call', { name: 'subagent_delete', arguments: { agent: 'a1' } });
  await rpc(5, 'tools/call', { name: 'remember', arguments: { note: 'uses pnpm' } });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['GET /api/sessions/s1/subagents', 'DELETE /api/sessions/s1/subagents/a1', 'POST /api/memory/append']);
  assert.ok(calls.every((c) => c.token === 'tok'));
  child.stdin.end();
  server.close();
});
