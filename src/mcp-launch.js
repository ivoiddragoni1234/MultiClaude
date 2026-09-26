// How Claude Code should start the MultiClaude MCP server: the exe itself with --mcp, or
// `node bin/multiclaude.js mcp` when running from source.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let isSea = false;
try {
  // eslint-disable-next-line no-undef
  isSea = typeof require !== 'undefined' && require('node:sea').isSea();
} catch { /* not a single-executable build */ }

export function mcpCommand() {
  if (isSea) return { command: process.execPath, args: ['--mcp'] };
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'multiclaude.js');
  return { command: process.execPath, args: [bin, 'mcp'] };
}
