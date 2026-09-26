// Reads Claude Code transcripts (the .jsonl files under ~/.claude/projects): chat history for the
// UI, subagent conversations, and the list of past conversations for /resume.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { isContinuePrompt } from './orchestrator.js';

const SESSION_RE = /^[\w-]{8,}$/;

export function findTranscript(sessionId) {
  if (!sessionId || !SESSION_RE.test(sessionId)) return null;
  const root = paths.projects;
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

/** Text the user typed, or null for tool results, commands, reminders and our own continuations. */
function typedText(msg) {
  const content = msg.message?.content;
  if (!(typeof content === 'string' || (Array.isArray(content) && content.some((b) => b.type === 'text')))) return null;
  const text = blockText(content);
  const t = text.trim();
  if (!t || isContinuePrompt(t) || /^<(command-|local-command|system-reminder|task-notification)/.test(t) || /^Caveat: The messages below/.test(t)) return null;
  return text;
}

/**
 * Convert transcript lines into UI events. `sidechain: true` reads a subagent transcript
 * (all of whose lines are sidechain lines).
 */
export function transcriptEvents(lines, { sidechain = false } = {}) {
  const events = [];
  const agentCalls = new Set();
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.isMeta || (!sidechain && msg.isSidechain)) continue;
    if (msg.type === 'attachment' && msg.attachment?.type === 'queued_command' && typeof msg.attachment.prompt === 'string') {
      events.push({ type: 'user', text: msg.attachment.prompt, midTurn: true });
      continue;
    }
    const content = msg.message?.content;
    if (msg.type === 'user') {
      if (msg.isCompactSummary) { events.push({ type: 'compact', trigger: 'auto' }); continue; }
      const text = typedText(msg);
      if (text) events.push({ type: 'user', text });
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== 'tool_result') continue;
        const out = blockText(b.content);
        if (agentCalls.has(b.tool_use_id) && /agent launched/i.test(out)) continue; // internal bookkeeping
        events.push({ type: 'tool_result', toolUseId: b.tool_use_id, isError: Boolean(b.is_error), content: clip(out), parentId: null });
      }
    } else if (msg.type === 'assistant') {
      if (msg.isApiErrorMessage) continue; // limit errors are handled by switching accounts, don't show them
      for (const b of content || []) {
        if (b.type === 'text' && b.text.trim()) events.push({ type: 'text', text: `${b.text}\n`, block: true });
        if (b.type === 'tool_use') {
          if (b.name === 'Agent' || b.name === 'Task') agentCalls.add(b.id);
          events.push({ type: 'tool', id: b.id, name: b.name, input: b.input, parentId: null, subagent: false });
        }
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

/** Subagents recorded on disk for a session: [{agentId, id (tool use id), description, type, file}] */
export function listSubagentFiles(sessionId) {
  const main = findTranscript(sessionId);
  if (!main) return [];
  const dir = path.join(main.slice(0, -'.jsonl'.length), 'subagents');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^agent-([\w-]+)\.meta\.json$/);
    if (!m) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* partial */ }
    const file = path.join(dir, `agent-${m[1]}.jsonl`);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* no transcript yet */ }
    out.push({ agentId: m[1], id: meta.toolUseId || `agent-${m[1]}`, description: meta.description || 'Subagent', type: meta.agentType || 'general-purpose', file, mtime });
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

export function loadSubagentHistory(file) {
  try {
    return transcriptEvents(fs.readFileSync(file, 'utf8').split('\n'), { sidechain: true });
  } catch {
    return [];
  }
}

export function deleteSubagentFiles(file) {
  for (const f of [file, file.replace(/\.jsonl$/, '.meta.json')]) fs.rmSync(f, { force: true });
}

function readHead(file, bytes = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file, bytes = 64 * 1024) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Past conversations for /resume, newest first. */
export function listConversations({ limit = 200 } = {}) {
  const root = paths.projects;
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    let entries = [];
    try { entries = fs.readdirSync(full); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue;
      const file = path.join(full, f);
      try { files.push({ file, id: f.slice(0, -6), mtime: fs.statSync(file).mtimeMs }); } catch { /* vanished */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    let cwd = null;
    let title = null;
    let firstPrompt = null;
    let messages = 0;
    try {
      const lines = readHead(f.file).split('\n');
      for (const line of lines) {
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        cwd ||= m.cwd || null;
        if (m.type === 'summary' && m.summary) title ||= m.summary;
        if (m.type === 'custom-title' && m.customTitle) title = m.customTitle;
        if (m.type === 'user' && !m.isMeta && !m.isSidechain) {
          const t = typedText(m);
          if (t) { messages += 1; firstPrompt ||= t; }
        }
      }
      for (const line of readTail(f.file).split('\n')) {
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'custom-title' && m.customTitle) title = m.customTitle;
        if ((m.type === 'ai-title' || m.type === 'summary') && (m.aiTitle || m.summary)) title ||= m.aiTitle || m.summary;
      }
    } catch { continue; }
    if (!firstPrompt) continue; // empty or tool-only sessions
    out.push({
      id: f.id,
      title: (title || firstPrompt).replace(/\s+/g, ' ').trim().slice(0, 120),
      firstPrompt: firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 200),
      cwd,
      updatedAt: f.mtime,
      messages,
    });
  }
  return out;
}
