// Full-screen mode: runs the real interactive Claude Code UI as one account. When the session
// ends because the account hit its limit, it resumes the same conversation on the next account.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { paths } from './paths.js';
import { lineShowsLimit, parseResetTime } from './limits.js';
import { memoryPrompt } from './memory.js';
import { waitUntil } from './orchestrator.js';
import { claudeSpawn } from './claude-path.js';

function newestTranscript(since) {
  const root = path.join(paths.shared, 'projects');
  let best = null;
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(full, f);
      const mtime = fs.statSync(file).mtimeMs;
      if (mtime >= since && (!best || mtime > best.mtime)) best = { file, mtime, sessionId: f.slice(0, -6) };
    }
  }
  return best;
}

/** Look at the tail of a transcript for an API error saying the account ran out. */
export function transcriptLimit(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-15);
  for (const line of lines.reverse()) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === 'user' && !msg.isMeta && !msg.toolUseResult) {
      // a user message after the error means the user carried on; the tail is what matters
      const c = msg.message?.content;
      if (typeof c === 'string' || (Array.isArray(c) && c.some((b) => b.type === 'text'))) return null;
    }
    if (msg.type !== 'assistant') continue;
    const text = (msg.message?.content || []).map((b) => b.text || '').join(' ');
    if ((msg.isApiErrorMessage || msg.error) && lineShowsLimit(text)) return { text, resetsAt: parseResetTime(text) };
    if (msg.isApiErrorMessage) return null;
  }
  return null;
}

function launch(pool, account, sessionId, extraArgs) {
  const s = pool.settings;
  const args = [];
  if (sessionId) args.push('--resume', sessionId);
  if (s.model) args.push('--model', s.model);
  if (s.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else if (s.permissionMode && s.permissionMode !== 'default') args.push('--permission-mode', s.permissionMode);
  args.push('--append-system-prompt', memoryPrompt(), ...extraArgs);
  return new Promise((resolve, reject) => {
    const sp = claudeSpawn(s.claudePath, args);
    const child = spawn(sp.command, sp.args, { ...sp.options, windowsHide: false, stdio: 'inherit', env: pool.envFor(account) });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

export async function runTui(pool, { sessionId = null, extraArgs = [], auto = false } = {}) {
  const rl = () => readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    pool.load();
    let account = pool.pick();
    if (!account) {
      const until = pool.earliestReset();
      if (!until || pool.settings.onAllLimited !== 'wait') {
        console.error('No account is available right now.');
        return;
      }
      console.log(`All accounts are limited. Waiting until ${new Date(until).toLocaleString()} (Ctrl+C to quit)…`);
      await waitUntil(until + 5000);
      continue;
    }
    if (account.id !== pool.active?.id) pool.setActive(account.id);
    console.log(`\n▶ MultiClaude: launching Claude Code as "${account.name}" (${account.type})${sessionId ? `, resuming ${sessionId}` : ''}\n`);
    const started = Date.now();
    await launch(pool, account, sessionId, extraArgs);

    const t = newestTranscript(started - 1000);
    if (t) sessionId = t.sessionId;
    const hit = t && transcriptLimit(t.file);
    if (!hit) return;

    const until = hit.resetsAt || Date.now() + pool.settings.defaultCooldownMinutes * 6e4;
    pool.markLimited(account.id, until, hit.text.slice(0, 200));
    const next = pool.pick();
    console.log(`\n⚠ "${account.name}" hit its usage limit (resets ${new Date(until).toLocaleString()}).`);
    if (!auto) {
      const r = rl();
      const where = next ? `on "${next.name}"` : 'after waiting for a reset';
      const answer = (await r.question(`Continue this conversation ${where}? [Y/n] `)).trim().toLowerCase();
      r.close();
      if (answer.startsWith('n')) return;
    }
  }
}
