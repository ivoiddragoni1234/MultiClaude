import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclaude-test-'));
process.env.MULTICLAUDE_HOME = tmp;
process.env.FAKE_LOG = path.join(tmp, 'calls.log');
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.js');

const { AccountPool } = await import('../src/accounts.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { paths } = await import('../src/paths.js');

function freshPool(keys, settings = {}) {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const pool = new AccountPool();
  Object.assign(pool.settings, { claudePath: fake, ...settings });
  for (const k of keys) pool.add({ name: k, type: 'api', secret: k });
  pool.save();
  return pool;
}
const calls = () => fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('fails over to the next account and resumes the same session', async () => {
  const pool = freshPool(['key-limited', 'key-ok']);
  const orch = new Orchestrator(pool, { sessionId: 'sess-1' });
  const events = [];
  for (const e of ['switch', 'limited']) orch.on(e, (p) => events.push(e));
  const r = await orch.send('do the thing');
  assert.equal(r.text, 'hello from key-ok');
  assert.equal(r.account.id, 'key-ok');
  assert.deepEqual(events, ['limited', 'switch']);
  const log = calls();
  assert.equal(log.length, 2);
  assert.equal(log[0].prompt, 'do the thing');
  assert.equal(log[1].resume, 'sess-1');
  assert.match(log[1].prompt, /Continue exactly where you left off/);
  assert.notEqual(log[0].configDir, log[1].configDir);
  pool.load();
  const limited = pool.describe().find((a) => a.id === 'key-limited');
  assert.equal(limited.status, 'limited');
  assert.ok(limited.limitedUntil > Date.now() + 50 * 6e4);
});

test('account profiles share transcripts and memory', () => {
  const pool = freshPool(['a', 'b']);
  for (const a of pool.accounts) {
    const dir = paths.accountDir(a.id);
    assert.equal(fs.realpathSync(path.join(dir, 'projects')), fs.realpathSync(path.join(paths.shared, 'projects')));
    assert.equal(fs.realpathSync(path.join(dir, 'CLAUDE.md')), fs.realpathSync(paths.memory));
  }
});

test('stops when every account is limited and onAllLimited=stop', async () => {
  const pool = freshPool(['key-limited'], { onAllLimited: 'stop' });
  await assert.rejects(new Orchestrator(pool).send('hi'), /All accounts are at their limit/);
});

test('disables accounts with bad credentials and moves on', async () => {
  const pool = freshPool(['key-auth', 'key-ok']);
  const r = await new Orchestrator(pool).send('hi');
  assert.equal(r.account.id, 'key-ok');
  pool.load();
  assert.equal(pool.find('key-auth').enabled, false);
});

test('switches early when a window is nearly full', async () => {
  const pool = freshPool(['key-nearly', 'key-ok']);
  const orch = new Orchestrator(pool);
  assert.equal((await orch.send('one')).account.id, 'key-nearly');
  assert.equal((await orch.send('two')).account.id, 'key-ok');
});

test('round-robin rotates every turn', async () => {
  const pool = freshPool(['key-a', 'key-b'], { strategy: 'round-robin' });
  const orch = new Orchestrator(pool);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await orch.send(`turn ${i}`)).account.id);
  assert.deepEqual(ids, ['key-a', 'key-b', 'key-a']);
});

test('wait strategy waits for the same account instead of switching', async () => {
  const pool = freshPool(['key-ok', 'key-other'], { strategy: 'wait' });
  pool.markLimited('key-ok', Date.now() + 1500, 'test');
  const orch = new Orchestrator(pool);
  let waited = false;
  orch.on('waiting', () => { waited = true; });
  const r = await orch.send('hi');
  assert.ok(waited);
  assert.equal(r.account.id, 'key-ok');
});

test('API keys never leak into other accounts\' environments', () => {
  const pool = freshPool(['key-a']);
  const env = pool.envFor(pool.accounts[0], { CLAUDE_CODE_OAUTH_TOKEN: 'x', ANTHROPIC_AUTH_TOKEN: 'y', PATH: '/bin' });
  assert.equal(env.ANTHROPIC_API_KEY, 'key-a');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.PATH, '/bin');
});
