import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclaude-sessions-'));
process.env.MULTICLAUDE_HOME = tmp;
process.env.MULTICLAUDE_CLAUDE_HOME = path.join(tmp, 'claude-home');
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.js');

const { AccountPool } = await import('../src/accounts.js');
const { SessionManager } = await import('../src/sessions.js');
const { transcriptEvents, listConversations } = await import('../src/transcript.js');
const { paths } = await import('../src/paths.js');

function setup(keys = ['key-ok']) {
  fs.rmSync(path.join(tmp, 'config.json'), { force: true });
  fs.rmSync(path.join(tmp, 'state.json'), { force: true });
  fs.rmSync(path.join(tmp, 'sessions.json'), { force: true });
  const pool = new AccountPool();
  Object.assign(pool.settings, { claudePath: fake });
  keys.forEach((k, i) => pool.add({ name: `pro${i + 1}`, type: 'token', secret: k }));
  pool.save();
  const mgr = new SessionManager(pool, { defaultCwd: tmp });
  const s = mgr.create({});
  const events = [];
  mgr.subscribe(s.id, { write: (chunk) => events.push(JSON.parse(chunk.slice(6))) });
  return { pool, mgr, s, events };
}

const until = (fn, ms = 8000) => new Promise((resolve, reject) => {
  const start = Date.now();
  const t = setInterval(() => {
    const v = fn();
    if (v) { clearInterval(t); resolve(v); } else if (Date.now() - start > ms) { clearInterval(t); reject(new Error('timed out')); }
  }, 20);
});

test('rebuilds history from a transcript and hides silent continuations', () => {
  const lines = [
    { type: 'user', message: { content: 'build it' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'On it' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: 'also do this' } },
    { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'usage limit reached' }] } },
    { type: 'user', message: { content: 'Your previous turn was cut off because the account running it hit a usage limit. more' } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued...' } },
  ].map((l) => JSON.stringify(l));
  assert.deepEqual(transcriptEvents(lines).map((e) => e.type), ['user', 'text', 'tool', 'tool_result', 'user', 'compact']);
});

test('switches accounts silently and keeps subagent activity out of the main chat', async () => {
  const { mgr, s, events } = setup(['key-limited', 'key-ok']);
  mgr.send(s.id, 'run an agent please', { model: 'opus' });
  await until(() => events.find((e) => e.type === 'done'));
  const types = events.map((e) => e.type);
  assert.ok(types.includes('limited') && types.includes('switch'));
  assert.equal(events.filter((e) => e.type === 'user').length, 1, 'the continuation prompt is never shown');
  assert.equal(events.find((e) => e.type === 'done').error, undefined);
  assert.ok(!events.some((e) => e.type === 'tool' && e.name === 'Grep'), 'subagent tools stay out of the main chat');
  const sub = mgr.subagents(s.id);
  assert.equal(sub.length, 1);
  assert.equal(sub[0].status, 'done');
  const subEvents = [];
  mgr.subscribeSubagent(s.id, sub[0].id, { write: (c) => subEvents.push(JSON.parse(c.slice(6))) });
  assert.deepEqual(subEvents.filter((e) => e.type !== 'ready').map((e) => e.type), ['user', 'tool', 'tool_result', 'text']);
  assert.equal(mgr.get(s.id).claudeSessionId, 'sess-1');
  assert.match(mgr.rememberSubagent(s.id, sub[0].id), /Explore the repo/);
  mgr.deleteSubagent(s.id, sub[0].id);
  assert.equal(mgr.subagents(s.id).length, 0);
  mgr.closeAll();
});

test('accepts messages while Claude is working and Stop interrupts the turn', async () => {
  const { mgr, s, events } = setup();
  const log = path.join(tmp, 'calls.log');
  process.env.FAKE_LOG = log;
  fs.rmSync(log, { force: true });
  mgr.send(s.id, 'slow task');
  await until(() => events.find((e) => e.type === 'tool'));
  mgr.send(s.id, 'and another thing');
  const calls = await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim().split('\n').length >= 1 && fs.readFileSync(log, 'utf8'));
  assert.match(calls, /slow task/);
  mgr.stop(s.id);
  await until(() => events.find((e) => e.type === 'done'));
  assert.equal(events.find((e) => e.type === 'done').aborted, true);
  assert.equal(events.filter((e) => e.type === 'user').at(-1).midTurn, true);
  await until(() => fs.readFileSync(log, 'utf8').includes('and another thing'));
  delete process.env.FAKE_LOG;
  mgr.closeAll();
});

test('asks the UI for permission and passes the answer to Claude', async () => {
  const { mgr, s, events } = setup();
  mgr.send(s.id, 'needs permission');
  const req = await until(() => events.find((e) => e.type === 'permission'));
  assert.equal(req.toolName, 'Write');
  mgr.answerPermission(s.id, req.requestId, 'deny');
  const result = await until(() => events.find((e) => e.type === 'tool_result' && e.toolUseId === 'tu_w'));
  assert.equal(result.isError, true);
  assert.ok(events.some((e) => e.type === 'permission_done' && e.decision === 'deny'));
  await until(() => events.find((e) => e.type === 'done'));
  mgr.closeAll();
});

test('/resume lists Claude Code conversations and reopens them', () => {
  const { mgr } = setup();
  const dir = path.join(paths.projects, '-home-me-proj');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', cwd: tmp, message: { content: 'Fix the login bug' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } },
  ];
  fs.writeFileSync(path.join(dir, 'abc12345-conv.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const list = listConversations();
  const c = list.find((x) => x.id === 'abc12345-conv');
  assert.equal(c.title, 'Fix the login bug');
  assert.equal(c.cwd, tmp);
  const opened = mgr.resume({ claudeSessionId: c.id, cwd: c.cwd, title: c.title });
  assert.equal(mgr.resume({ claudeSessionId: c.id }).id, opened.id, 'reuses the same session');
  const events = [];
  mgr.subscribe(opened.id, { write: (chunk) => events.push(JSON.parse(chunk.slice(6))) });
  assert.deepEqual(events.filter((e) => e.replay).map((e) => e.type), ['user', 'text']);
  mgr.closeAll();
});
