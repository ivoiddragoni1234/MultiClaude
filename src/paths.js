import os from 'node:os';
import path from 'node:path';

export function homeDir() {
  return process.env.MULTICLAUDE_HOME || path.join(os.homedir(), '.multiclaude');
}

/** Your normal Claude Code folder (~/.claude). */
export function claudeHome() {
  return process.env.MULTICLAUDE_CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

/** Share conversation history with normal Claude Code unless turned off. */
export const shareHistory = () => process.env.MULTICLAUDE_SEPARATE_HISTORY !== '1';

export const paths = {
  get home() { return homeDir(); },
  get config() { return path.join(homeDir(), 'config.json'); },
  get state() { return path.join(homeDir(), 'state.json'); },
  get accounts() { return path.join(homeDir(), 'accounts'); },
  get shared() { return path.join(homeDir(), 'shared'); },
  get memory() { return path.join(homeDir(), 'shared', 'CLAUDE.md'); },
  get logs() { return path.join(homeDir(), 'logs'); },
  /**
   * Where conversation transcripts live. Normally the same folder plain Claude Code uses, so
   * `claude --resume` sees MultiClaude conversations and MultiClaude's /resume sees Claude Code's.
   */
  get projects() { return shareHistory() ? path.join(claudeHome(), 'projects') : path.join(homeDir(), 'shared', 'projects'); },
  accountDir(id) { return path.join(homeDir(), 'accounts', id); },
};
