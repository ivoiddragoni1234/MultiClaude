// Finds the Claude Code CLI. A desktop app doesn't get a login shell's PATH, and on Windows
// npm installs a `claude.cmd` shim that can't be spawned directly, so look in the usual places.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';
let cached = null;

function candidateDirs() {
  const home = os.homedir();
  const env = process.env;
  const fromPath = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const extra = isWin
    ? [
        path.join(home, '.local', 'bin'), // native installer
        env.APPDATA && path.join(env.APPDATA, 'npm'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'claude'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'AnthropicClaude'),
      ]
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.claude', 'local'),
        path.join(home, '.npm-global', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
      ];
  return [...fromPath, ...extra.filter(Boolean)];
}

const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

function findNode(dir) {
  for (const d of [dir, ...candidateDirs()]) {
    const f = path.join(d, isWin ? 'node.exe' : 'node');
    if (exists(f)) return f;
  }
  return 'node';
}

/**
 * @returns {{command: string, args: string[], shell: boolean, found: boolean, path: string|null}}
 */
export function resolveClaude(configured = 'claude') {
  if (configured && configured !== 'claude') {
    if (isWin && configured.endsWith('.js')) return { command: findNode(path.dirname(configured)), args: [configured], shell: false, found: exists(configured), path: configured };
    return { command: configured, args: [], shell: false, found: exists(configured) || !configured.includes(path.sep), path: configured };
  }
  if (cached?.found) return cached;

  const exts = isWin ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of candidateDirs()) {
    for (const ext of exts) {
      const file = path.join(dir, `claude${ext}`);
      if (!exists(file)) continue;
      if (ext === '.cmd' || ext === '.bat') {
        // npm shim: run its cli.js with node directly (spawning .cmd files needs a shell)
        const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        cached = exists(cli)
          ? { command: findNode(dir), args: [cli], shell: false, found: true, path: file }
          : { command: file, args: [], shell: true, found: true, path: file };
      } else {
        cached = { command: file, args: [], shell: false, found: true, path: file };
      }
      return cached;
    }
  }
  return { command: 'claude', args: [], shell: false, found: false, path: null };
}

/** Quote arguments for the rare case where we must go through cmd.exe. */
export function shellQuote(arg) {
  const s = String(arg);
  if (isWin) return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Arguments for child_process.spawn that run Claude Code with `args`, without a console window. */
export function claudeSpawn(configured, args) {
  const r = resolveClaude(configured);
  if (r.shell) return { command: [r.command, ...args].map(shellQuote).join(' '), args: [], options: { shell: true, windowsHide: true } };
  return { command: r.command, args: [...r.args, ...args], options: { windowsHide: true } };
}

export const INSTALL_HINT = isWin
  ? 'Install Claude Code: open PowerShell and run  irm https://claude.ai/install.ps1 | iex'
  : 'Install Claude Code: run  curl -fsSL https://claude.ai/install.sh | bash';
