import fs from 'node:fs';
import { paths } from './paths.js';
import { ensureSharedLayout } from './accounts.js';

// Memory lives in the shared CLAUDE.md that every account profile links to, so Claude Code
// loads it automatically as user memory in every session, whichever account is running.

export function readMemory() {
  ensureSharedLayout();
  return fs.readFileSync(paths.memory, 'utf8');
}

export function writeMemory(text) {
  ensureSharedLayout();
  fs.writeFileSync(paths.memory, text.endsWith('\n') ? text : `${text}\n`);
}

export function remember(note) {
  const clean = String(note).trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('Nothing to remember');
  ensureSharedLayout();
  const stamp = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(paths.memory, `- [${stamp}] ${clean}\n`);
  return clean;
}

export function forgetAll() {
  fs.rmSync(paths.memory, { force: true });
  ensureSharedLayout();
}

export function memoryPrompt() {
  return [
    'You are running inside MultiClaude, which rotates this conversation across several accounts.',
    'The conversation may have moved to a different account mid-task; carry on seamlessly.',
    `Your long-term memory file is ${paths.memory} (already loaded into your context as user memory).`,
    'When you learn something worth keeping across sessions (user preferences, project facts, decisions),',
    'append a concise bullet to that file with your file tools. Keep it tidy; do not store secrets.',
  ].join(' ');
}
