import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclaude-sessions-'));
process.env.MULTICLAUDE_HOME = tmp;
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.js');

const { AccountPool } = await import('../src/accounts.js');
const { SessionManager } = await import('../src/sessions.js');
const { transcriptEvents } = await import('../src/transcript.js');

test('rebuilds history from a transcript and hides silent continuations', () => {
  const lines = [
    { type: 'user', message: { content: 'build it' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'On it' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } },
    { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'usage limit reached' }] } },
    { type: 'user', message: { content: 'Your previous turn was cut off because the account running it hit a usage limit. more' } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
  ].map((l) => JSON.stringify(l));
  assert.deepEqual(transcriptEvents(lines).map((e) => e.type), ['user', 'text', 'tool', 'tool_result']);
});

test('switches accounts silently inside one web session', async () => {
  const pool = new AccountPool();
  Object.assign(pool.settings, { claudePath: fake });
  pool.add({ name: 'pro1', type: 'token', secret: 'key-limited' });
  pool.add({ name: 'pro2', type: 'token', secret: 'key-ok' });
  const mgr = new SessionManager(pool, { defaultCwd: tmp });
  const s = mgr.create({});
  const events = [];
  const res = { write: (chunk) => events.push(JSON.parse(chunk.slice(6))) };
  mgr.subscribe(s.id, res);
  mgr.send(s.id, 'run an agent please', { model: 'opus' });
  await new Promise((resolve) => { const t = setInterval(() => { if (events.some((e) => e.type === 'done')) { clearInterval(t); resolve(); } }, 20); });
  const types = events.map((e) => e.type);
  assert.ok(types.includes('limited') && types.includes('switch'));
  assert.equal(events.filter((e) => e.type === 'user').length, 1, 'the continuation prompt is never shown');
  const sub = events.find((e) => e.type === 'tool' && e.parentId === 'tu_task');
  assert.equal(sub.name, 'Grep');
  assert.equal(events.find((e) => e.type === 'done').error, undefined);
  assert.equal(mgr.get(s.id).title, 'run an agent please');
  assert.equal(mgr.get(s.id).claudeSessionId, 'sess-1');
});
