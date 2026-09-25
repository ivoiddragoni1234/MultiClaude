import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResetTime, classifyOutcome, readRateLimitEvent, lineShowsLimit } from '../src/limits.js';

const now = new Date('2026-01-01T10:00:00').getTime();

test('parses epoch reset times', () => {
  assert.equal(parseResetTime('Claude AI usage limit reached|1790388000', now), 1790388000 * 1000);
});

test('parses relative reset times', () => {
  assert.equal(parseResetTime('please try again in 15 minutes', now), now + 15 * 6e4);
  assert.equal(parseResetTime('resets in 2h 5m', now), now + 2 * 36e5 + 5 * 6e4);
});

test('parses clock reset times, rolling to tomorrow when past', () => {
  assert.equal(parseResetTime("You've hit your limit · resets 3pm", now), new Date('2026-01-01T15:00:00').getTime());
  assert.equal(parseResetTime('5-hour limit reached ∙ resets 9:30am', now), new Date('2026-01-02T09:30:00').getTime());
});

test('classifies outcomes', () => {
  assert.equal(classifyOutcome({ result: { is_error: false, result: 'hi' } }).kind, 'ok');
  assert.equal(classifyOutcome({ result: { is_error: true, result: 'Claude AI usage limit reached|1790388000' } }).kind, 'rate_limited');
  assert.equal(classifyOutcome({ result: { is_error: true, result: 'Credit balance is too low' } }).kind, 'billing');
  assert.equal(classifyOutcome({ result: { is_error: true, result: 'Invalid API key · Please run /login' } }).kind, 'auth');
  assert.equal(classifyOutcome({ result: { is_error: true, result: 'API Error: 529 Overloaded' } }).kind, 'overloaded');
  assert.equal(classifyOutcome({ result: null, exitCode: 1, stderr: 'boom' }).kind, 'error');
  const rl = readRateLimitEvent({ status: 'rejected', resetsAt: 1790388000, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1790388000 } } });
  const out = classifyOutcome({ result: { is_error: true, result: 'error' }, rateLimit: rl });
  assert.deepEqual([out.kind, out.resetsAt], ['rate_limited', 1790388000 * 1000]);
  assert.equal(rl.windows.five_hour.utilization, 1);
});

test('spots limits in transcript text', () => {
  assert.ok(lineShowsLimit("You've hit your limit · resets 3pm"));
  assert.ok(!lineShowsLimit('Here is your answer'));
});
