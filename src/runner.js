import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { classifyOutcome, readRateLimitEvent } from './limits.js';
import { memoryPrompt } from './memory.js';

export function buildArgs({ settings, sessionId, overrides = {} }) {
  const opt = { ...settings, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v != null && v !== '')) };
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (sessionId) args.push('--resume', sessionId);
  if (opt.model && opt.model !== 'default') args.push('--model', opt.model);
  if (opt.effort) args.push('--effort', opt.effort);
  if (opt.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else if (opt.permissionMode && opt.permissionMode !== 'default') args.push('--permission-mode', opt.permissionMode);
  args.push('--append-system-prompt', memoryPrompt());
  args.push(...(opt.extraArgs || []));
  return args;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
}

/**
 * Run a single Claude Code turn as `account` and stream events.
 * Events passed to onEvent:
 *   {type:'text', text}                                  streamed assistant text (top level only)
 *   {type:'tool', id, name, input, parentId, subagent}   a tool call; parentId = the Task call a subagent runs under
 *   {type:'tool_result', toolUseId, isError, content, parentId}
 *   {type:'session', sessionId} | {type:'rate_limit', info} | {type:'raw', msg}
 */
export function runTurn({ pool, account, prompt, sessionId, overrides, cwd = process.cwd(), onEvent = () => {}, signal }) {
  const settings = pool.settings;
  const args = buildArgs({ settings, sessionId, overrides });
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
            if (block.type === 'tool_use') {
              onEvent({
                type: 'tool', id: block.id, name: block.name, input: block.input,
                parentId: msg.parent_tool_use_id || null, subagent: Boolean(msg.parent_tool_use_id),
              });
            }
          }
          break;
        case 'user':
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_result') {
              const content = resultText(block.content);
              onEvent({
                type: 'tool_result', toolUseId: block.tool_use_id, isError: Boolean(block.is_error),
                content: content.length > 8000 ? `${content.slice(0, 8000)}\n… (${content.length - 8000} more characters)` : content,
                parentId: msg.parent_tool_use_id || null,
              });
            }
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
