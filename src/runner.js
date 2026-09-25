import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { classifyOutcome, readRateLimitEvent } from './limits.js';
import { memoryPrompt } from './memory.js';

export function buildArgs({ settings, sessionId }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (sessionId) args.push('--resume', sessionId);
  if (settings.model) args.push('--model', settings.model);
  if (settings.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else if (settings.permissionMode) args.push('--permission-mode', settings.permissionMode);
  args.push('--append-system-prompt', memoryPrompt());
  args.push(...(settings.extraArgs || []));
  return args;
}

/**
 * Run a single Claude Code turn as `account` and stream events.
 * Events passed to onEvent: {type:'text', text} | {type:'tool', name, input} | {type:'tool_result', isError}
 *   | {type:'session', sessionId} | {type:'rate_limit', info} | {type:'raw', msg}
 */
export function runTurn({ pool, account, prompt, sessionId, cwd = process.cwd(), onEvent = () => {}, signal }) {
  const settings = pool.settings;
  const args = buildArgs({ settings, sessionId });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(settings.claudePath || 'claude', args, {
        cwd,
        env: pool.envFor(account),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let result = null;
    let rateLimit = null;
    let newSessionId = sessionId || null;
    let stderr = '';
    let streamedText = false;

    const onAbort = () => child.kill('SIGINT');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err.code === 'ENOENT'
        ? new Error(`Could not find the Claude Code CLI ("${settings.claudePath}"). Install it with: npm i -g @anthropic-ai/claude-code`)
        : err);
    });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.session_id && msg.session_id !== newSessionId && (msg.type === 'system' || msg.type === 'result')) {
        newSessionId = msg.session_id;
        onEvent({ type: 'session', sessionId: newSessionId });
      }
      switch (msg.type) {
        case 'stream_event': {
          const ev = msg.event;
          if (!msg.parent_tool_use_id && ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            streamedText = true;
            onEvent({ type: 'text', text: ev.delta.text });
          }
          if (!msg.parent_tool_use_id && ev?.type === 'message_stop' && streamedText) onEvent({ type: 'text', text: '\n' });
          break;
        }
        case 'assistant':
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_use') onEvent({ type: 'tool', name: block.name, input: block.input, subagent: Boolean(msg.parent_tool_use_id) });
          }
          break;
        case 'user':
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_result' && block.is_error) onEvent({ type: 'tool_result', isError: true });
          }
          break;
        case 'rate_limit_event':
          rateLimit = readRateLimitEvent(msg.rate_limit_info);
          onEvent({ type: 'rate_limit', info: rateLimit });
          break;
        case 'result':
          result = msg;
          break;
        default:
          break;
      }
      onEvent({ type: 'raw', msg });
    });

    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      const aborted = Boolean(signal?.aborted);
      const outcome = aborted
        ? { kind: 'aborted', resetsAt: null, message: 'interrupted' }
        : classifyOutcome({ result, rateLimit, stderr, exitCode: code ?? (sig ? 1 : 0) });
      resolve({
        outcome,
        sessionId: newSessionId,
        text: typeof result?.result === 'string' ? result.result : '',
        costUsd: result?.total_cost_usd || 0,
        rateLimit,
        stderr,
      });
    });
  });
}
