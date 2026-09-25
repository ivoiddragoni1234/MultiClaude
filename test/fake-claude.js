#!/usr/bin/env node
// Stand-in for the `claude` CLI. Behaviour is chosen by the API key:
//   key-limited  -> usage limit error     key-auth -> auth error
//   key-nearly   -> succeeds, window 99% full        anything else -> succeeds
import fs from 'node:fs';
const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
const args = process.argv.slice(2);
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const session = resume || 'sess-1';
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ key, resume, prompt, configDir: process.env.CLAUDE_CONFIG_DIR }) + '\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', session_id: session });
  const reset = Math.floor(Date.now() / 1000) + 3600;
  if (key === 'key-limited') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: reset } } } });
    out({ type: 'result', subtype: 'error', is_error: true, result: `Claude AI usage limit reached|${reset}`, session_id: session });
    return;
  }
  if (key === 'key-auth') {
    out({ type: 'result', subtype: 'error', is_error: true, result: 'Invalid API key · Please run /login', session_id: session });
    process.exitCode = 1;
    return;
  }
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `hello from ${key}` } }, session_id: session });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }, session_id: session });
  const util = key === 'key-nearly' ? 0.99 : 0.2;
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: reset, unifiedWindows: { five_hour: { utilization: util, resetsAt: reset } } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: `hello from ${key}`, total_cost_usd: 0.01, session_id: session });
});
