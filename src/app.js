// Desktop launcher (what MultiClaude.exe runs): starts the local server in the background,
// opens the UI in its own window, and exits once every window is closed and Claude is idle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AccountPool } from './accounts.js';
import { startServer } from './server.js';
import { paths } from './paths.js';
import { openWindow, showError } from './desktop.js';
import { VERSION } from './version.js';

const PORT = 7878;
const IDLE_EXIT_MS = 20000;

function setupLogging() {
  fs.mkdirSync(paths.logs, { recursive: true });
  const file = path.join(paths.logs, 'app.log');
  try { if (fs.statSync(file).size > 5e6) fs.renameSync(file, `${file}.old`); } catch { /* first run */ }
  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
    try { fs.appendFileSync(file, line); } catch { /* ignore */ }
  };
  // A GUI app has no console, so everything goes to the log file.
  console.log = (...a) => write('info', a);
  console.error = (...a) => write('error', a);
  console.warn = (...a) => write('warn', a);
  return file;
}

function appToken() {
  const file = path.join(paths.home, 'app-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 20) return t;
  } catch { /* create below */ }
  const t = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

/** The version of MultiClaude already running on this port, or null. */
async function runningVersion(port, token) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'x-token': token }, signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return (await r.json()).version || '0.1.0';
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A different version is running (e.g. you just replaced the exe): ask it to quit and wait. */
async function replaceOldInstance(port, token) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST', headers: { 'x-token': token }, signal: AbortSignal.timeout(2000) });
  } catch { /* versions before 0.2.0 have no quit endpoint */ }
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!(await runningVersion(port, token))) return true;
  }
  return false;
}

export async function runApp() {
  const logFile = setupLogging();
  const token = appToken();
  const profileDir = path.join(paths.home, 'window');

  const running = await runningVersion(PORT, token);
  if (running === VERSION) {
    // Launched again while running: just open another window onto the running instance.
    openWindow(`http://127.0.0.1:${PORT}/#token=${token}`, profileDir);
    return;
  }
  if (running) {
    console.log(`replacing running version ${running} with ${VERSION}`);
    if (!(await replaceOldInstance(PORT, token))) console.log('old version did not quit; starting on another port');
  }

  const pool = new AccountPool();
  let started = null;
  for (const port of [PORT, PORT + 1, PORT + 2, PORT + 3, 0]) {
    try {
      started = await startServer(pool, { port, token, cwd: os.homedir(), onQuit: () => process.exit(0) });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  if (!started) throw new Error('Could not start the local server (ports 7878-7881 are busy).');
  console.log(`MultiClaude running at ${started.url.replace(/#.*/, '')} (log: ${logFile})`);

  process.on('exit', () => started.sessions.closeAll());
  const mode = openWindow(started.url, profileDir);
  console.log(`opened UI in ${mode} mode`);

  // Quit when no window has been connected for a while and no session is working.
  let idleSince = Date.now();
  let everConnected = false;
  setInterval(() => {
    const { windows, busy } = started.activity();
    if (windows > 0) everConnected = true;
    if (windows > 0 || busy) { idleSince = Date.now(); return; }
    // give a slow first launch a full minute to open its window
    const limit = everConnected ? IDLE_EXIT_MS : 60000;
    if (Date.now() - idleSince > limit) {
      console.log('no windows open and nothing running; exiting');
      process.exit(0);
    }
  }, 2000);
}

export function main() {
  runApp().catch((err) => {
    console.error(err);
    showError(`MultiClaude could not start:\n\n${err.message}`);
    process.exit(1);
  });
}
