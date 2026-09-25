// Rebuilds a chat history (in the web UI's event format) from a Claude Code session transcript,
// so past conversations can be reopened after the server restarts.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { isContinuePrompt } from './orchestrator.js';

export function findTranscript(sessionId) {
  if (!sessionId || /[\\/]/.test(sessionId)) return null;
  const root = path.join(paths.shared, 'projects');
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

const clip = (s, n = 8000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
}

/** Convert transcript lines into UI events: user, text, tool, tool_result. */
export function transcriptEvents(lines) {
  const events = [];
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.isMeta || msg.isSidechain) continue;
    const content = msg.message?.content;
    if (msg.type === 'user') {
      if (typeof content === 'string' || (Array.isArray(content) && content.some((b) => b.type === 'text'))) {
        const text = blockText(content);
        if (!text.trim() || isContinuePrompt(text) || /^<(command-|local-command|system-reminder)/.test(text.trim())) continue;
        events.push({ type: 'user', text });
      }
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'tool_result') {
          events.push({ type: 'tool_result', toolUseId: b.tool_use_id, isError: Boolean(b.is_error), content: clip(blockText(b.content)), parentId: null });
        }
      }
    } else if (msg.type === 'assistant') {
      if (msg.isApiErrorMessage) continue; // limit errors are handled by switching accounts, don't show them
      for (const b of content || []) {
        if (b.type === 'text' && b.text.trim()) events.push({ type: 'text', text: `${b.text}\n`, block: true });
        if (b.type === 'tool_use') events.push({ type: 'tool', id: b.id, name: b.name, input: b.input, parentId: null, subagent: false });
      }
    }
  }
  return events;
}

export function loadHistory(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return [];
  return transcriptEvents(fs.readFileSync(file, 'utf8').split('\n'));
}
