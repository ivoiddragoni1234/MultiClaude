#!/usr/bin/env node
// Stand-in for the `claude` CLI, in both single-shot (`-p`, prompt on stdin) and streaming
// (`--input-format stream-json`) modes. Behaviour is chosen by the API key:
//   key-limited  -> usage limit error     key-auth -> auth error
//   key-nearly   -> succeeds, window 99% full        anything else -> succeeds
// and by words in the prompt: "agent" runs a subagent, "slow" takes 3s, "permission" asks first.
import fs from 'node:fs';
import readline from 'node:readline';

const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
const args = process.argv.slice(2);
const streaming = args.includes('--input-format');
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const session = resume || 'sess-1';
const out = (o) => process.stdout.write(`${JSON.stringify({ session_id: session, ...o })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logCall = (prompt) => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ key, resume, prompt, configDir: process.env.CLAUDE_CONFIG_DIR, args })}\n`);
};

if (args.includes('--help')) {
  console.log('Usage: claude [options]\n  --permission-prompt-tool <tool>\n  --forward-subagent-text\n  --input-format <format>');
  process.exit(0);
}

let interrupted = false;
const pendingControl = new Map();

async function turn(prompt) {
  interrupted = false;
  const reset = Math.floor(Date.now() / 1000) + 3600;
  if (key === 'key-limited') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: reset } } } });
    out({ type: 'result', subtype: 'error', is_error: true, result: `Claude AI usage limit reached|${reset}` });
    return;
  }
  if (key === 'key-auth') {
    out({ type: 'result', subtype: 'error', is_error: true, result: 'Invalid API key · Please run /login' });
    return false;
  }
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `hello from ${key}` } } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'README.md\nsrc' }] } });
  if (/permission/.test(prompt)) {
    const requestId = `perm-${Date.now()}`;
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/x/a.txt', content: 'hi' }, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } });
    const answer = await new Promise((r) => pendingControl.set(requestId, r));
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_w', name: 'Write', input: { file_path: '/x/a.txt', content: 'hi' } }] } });
    const allowed = answer.response?.behavior === 'allow';
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_w', is_error: !allowed, content: allowed ? 'written' : answer.response?.message || 'denied' }] } });
  }
  if (/slow/.test(prompt)) {
    for (let i = 0; i < 30 && !interrupted; i++) await sleep(100);
    if (interrupted) { out({ type: 'result', subtype: 'error_during_execution', is_error: false, result: '' }); return; }
  }
  if (/agent|Continue exactly/.test(prompt)) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_task', name: 'Task', input: { description: 'Explore the repo', subagent_type: 'Explore', prompt: 'Look around' } }] } });
    out({ type: 'assistant', parent_tool_use_id: 'tu_task', message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Grep', input: { pattern: 'TODO' } }] } });
    out({ type: 'user', parent_tool_use_id: 'tu_task', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'src/a.js:1: TODO' }] } });
    out({ type: 'assistant', parent_tool_use_id: 'tu_task', message: { content: [{ type: 'text', text: 'Found one TODO in src/a.js.' }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_task', content: [{ type: 'text', text: 'Found **1** TODO.' }] }] } });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_3', name: 'Edit', input: { file_path: '/x/src/a.js', old_string: '// TODO', new_string: '// done' } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: 'ok' }] } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '\n\n## Summary\n- Fixed the `TODO`\n- Ran **tests**\n\n```js\nconsole.log(1)\n```' } } });
  }
  const util = key === 'key-nearly' ? 0.99 : 0.2;
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: reset, unifiedWindows: { five_hour: { utilization: util, resetsAt: reset } } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: `hello from ${key}`, total_cost_usd: 0.01 });
  return true;
}

if (streaming) {
  out({ type: 'system', subtype: 'init' });
  let chain = Promise.resolve();
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
      interrupted = true;
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
      return;
    }
    if (msg.type === 'control_response') { pendingControl.get(msg.response.request_id)?.(msg.response); return; }
    if (msg.type === 'user') {
      const prompt = typeof msg.message.content === 'string' ? msg.message.content : JSON.stringify(msg.message.content);
      logCall(prompt);
      chain = chain.then(() => turn(prompt));
    }
  }).on('close', () => chain.then(() => process.exit(0)));
} else {
  let prompt = '';
  process.stdin.on('data', (d) => { prompt += d; });
  process.stdin.on('end', async () => {
    logCall(prompt);
    out({ type: 'system', subtype: 'init' });
    const ok = await turn(prompt);
    if (ok === false) process.exitCode = 1;
  });
}
