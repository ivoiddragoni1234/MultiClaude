import os from 'node:os';
import path from 'node:path';

export function homeDir() {
  return process.env.MULTICLAUDE_HOME || path.join(os.homedir(), '.multiclaude');
}

export const paths = {
  get home() { return homeDir(); },
  get config() { return path.join(homeDir(), 'config.json'); },
  get state() { return path.join(homeDir(), 'state.json'); },
  get accounts() { return path.join(homeDir(), 'accounts'); },
  get shared() { return path.join(homeDir(), 'shared'); },
  get memory() { return path.join(homeDir(), 'shared', 'CLAUDE.md'); },
  get logs() { return path.join(homeDir(), 'logs'); },
  accountDir(id) { return path.join(homeDir(), 'accounts', id); },
};
