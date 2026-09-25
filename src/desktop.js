// Desktop integration: app windows, visible terminals for sign-in flows, and error dialogs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { resolveClaude, shellQuote } from './claude-path.js';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

function which(names) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) if (exists(path.join(dir, n))) return path.join(dir, n);
  }
  return null;
}

/** A Chromium-based browser that supports --app windows (Edge ships with Windows 10/11). */
export function findAppBrowser() {
  const env = process.env;
  const candidates = isWin
    ? [
        env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        env.ProgramFiles && path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : isMac
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : [which(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'])];
  return candidates.filter(Boolean).find(exists) || null;
}

/** Open the UI in its own window (no tabs or address bar), falling back to the default browser. */
export function openWindow(url, profileDir) {
  const browser = findAppBrowser();
  if (browser) {
    const child = spawn(browser, [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1320,880',
      '--no-first-run',
      '--no-default-browser-check',
    ], { stdio: 'ignore', detached: true });
    child.on('error', (err) => console.error('could not open app window', err));
    child.unref();
    return 'app';
  }
  const opener = isWin ? ['explorer.exe', [url]] : isMac ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(opener[0], opener[1], { stdio: 'ignore', detached: true });
  child.on('error', (err) => console.error(`could not open ${url.replace(/#.*/, '')} in a browser`, err));
  child.unref();
  return 'browser';
}

/**
 * Run a Claude Code command (e.g. `auth login`, `setup-token`) in a new, visible terminal window,
 * because those flows are interactive.
 */
export function openTerminal(claudePathSetting, claudeArgs, env) {
  const r = resolveClaude(claudePathSetting);
  if (!r.found) throw new Error('Claude Code is not installed yet.');
  const parts = [r.command, ...r.args, ...claudeArgs];
  if (isWin) {
    const line = parts.map((p) => `"${p}"`).join(' ');
    // start "<title>" cmd /k ""exe" args"  — /k keeps the window open so the token can be copied
    spawn('cmd.exe', ['/c', 'start', '"MultiClaude"', 'cmd.exe', '/k', `"${line}"`], {
      env, windowsVerbatimArguments: true, detached: true, stdio: 'ignore',
    }).on('error', () => {}).unref();
    return;
  }
  const exports = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
    .map((k) => (env[k] ? `export ${k}=${shellQuote(env[k])};` : `unset ${k};`)).join(' ');
  const cmd = `${exports} ${parts.map(shellQuote).join(' ')}`;
  if (isMac) {
    const script = `tell application "Terminal" to do script ${JSON.stringify(cmd)}\ntell application "Terminal" to activate`;
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return;
  }
  const term = which(['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']);
  if (!term) throw new Error(`No terminal found. Run this yourself: ${cmd}`);
  const args = term.endsWith('gnome-terminal') ? ['--', 'bash', '-c', `${cmd}; exec bash`] : ['-e', `bash -c ${shellQuote(`${cmd}; exec bash`)}`];
  spawn(term, args, { env, detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

/** A native error dialog, for when the app can't start (there's no console to print to). */
export function showError(message) {
  try {
    if (isWin) {
      const text = message.replace(/'/g, "''");
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text}', 'MultiClaude', 'OK', 'Error') | Out-Null`],
      { windowsHide: true });
    } else if (isMac) {
      spawnSync('osascript', ['-e', `display alert "MultiClaude" message ${JSON.stringify(message)} as critical`]);
    } else {
      process.stderr.write(`MultiClaude: ${message}\n`);
    }
  } catch { /* nothing else we can do */ }
}

export const defaultProjectsDir = () => os.homedir();
