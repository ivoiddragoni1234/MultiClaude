import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './paths.js';
import { readJson, writeJson } from './store.js';

export const ACCOUNT_TYPES = {
  api: 'Anthropic API key (ANTHROPIC_API_KEY)',
  token: 'Claude subscription long-lived token (from `claude setup-token`)',
  login: 'Claude subscription signed in with `claude auth login` into its own profile',
};

export const STRATEGIES = {
  failover: 'Stay on one account until it hits its limit, then move to the next',
  'round-robin': 'Rotate to the next available account after every turn',
  wait: 'Never switch: wait for the current account to reset',
};

export const DEFAULT_SETTINGS = {
  strategy: 'failover',
  onAllLimited: 'wait', // 'wait' | 'stop'
  switchAtUtilization: 0.97, // switch proactively once a window is this full (0-1); 1 disables
  defaultCooldownMinutes: 60, // used when a limit message has no reset time
  maxWaitHours: 24 * 7,
  claudePath: 'claude',
  model: '',
  permissionMode: 'acceptEdits', // default | acceptEdits | plan | bypassPermissions
  extraArgs: [],
};

// Things every account profile shares, so any account can pick up where another left off.
// `projects` holds session transcripts (needed for --resume across accounts).
const SHARED_DIRS = ['projects', 'agents', 'commands', 'skills', 'plugins', 'todos'];
const SHARED_FILES = ['CLAUDE.md', 'settings.json'];

const AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'];

export function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || crypto.randomBytes(3).toString('hex');
}

export function mask(secret) {
  if (!secret) return '';
  return secret.length <= 12 ? '••••' : `${secret.slice(0, 10)}…${secret.slice(-4)}`;
}

export function ensureSharedLayout() {
  fs.mkdirSync(paths.shared, { recursive: true, mode: 0o700 });
  for (const d of SHARED_DIRS) fs.mkdirSync(path.join(paths.shared, d), { recursive: true });
  const settings = path.join(paths.shared, 'settings.json');
  if (!fs.existsSync(settings)) fs.writeFileSync(settings, '{}\n');
  if (!fs.existsSync(paths.memory)) {
    fs.writeFileSync(
      paths.memory,
      '# MultiClaude memory\n\nLong-term notes shared by every account. Claude reads this at the start of every session.\n\n',
    );
  }
}

function linkShared(accountDir) {
  for (const name of [...SHARED_DIRS, ...SHARED_FILES]) {
    const target = path.join(paths.shared, name);
    const link = path.join(accountDir, name);
    let st = null;
    try { st = fs.lstatSync(link); } catch { /* missing */ }
    if (st?.isSymbolicLink()) continue;
    if (st) {
      // A real file/dir already exists (e.g. created by claude before linking): merge it into shared.
      if (st.isDirectory()) fs.cpSync(link, target, { recursive: true, force: false, errorOnExist: false });
      fs.rmSync(link, { recursive: true, force: true });
    }
    fs.symlinkSync(target, link, st?.isDirectory() || SHARED_DIRS.includes(name) ? 'dir' : 'file');
  }
}

export class AccountPool {
  constructor() {
    this.load();
  }

  load() {
    this.config = readJson(paths.config, { accounts: [], settings: {}, activeAccountId: null });
    this.config.settings = { ...DEFAULT_SETTINGS, ...this.config.settings };
    this.state = readJson(paths.state, { accounts: {} });
    return this;
  }

  save() {
    writeJson(paths.config, this.config);
    writeJson(paths.state, this.state);
  }

  get settings() { return this.config.settings; }
  get accounts() { return this.config.accounts; }

  stateOf(id) {
    this.state.accounts[id] ??= { limitedUntil: null, lastError: null, lastUsed: null, turns: 0, costUsd: 0, windows: {} };
    return this.state.accounts[id];
  }

  find(ref) {
    if (!ref) return null;
    const r = String(ref).toLowerCase();
    return this.accounts.find((a) => a.id === r || a.name.toLowerCase() === r) || this.accounts[Number(ref) - 1] || null;
  }

  add({ name, type, secret }) {
    if (!ACCOUNT_TYPES[type]) throw new Error(`Unknown account type "${type}". Use one of: ${Object.keys(ACCOUNT_TYPES).join(', ')}`);
    if (type !== 'login' && !secret) throw new Error(`A ${type === 'api' ? 'API key' : 'token'} is required`);
    let id = slug(name);
    while (this.accounts.some((a) => a.id === id)) id = `${slug(name)}-${crypto.randomBytes(2).toString('hex')}`;
    const account = { id, name, type, secret: secret || null, enabled: true, addedAt: new Date().toISOString() };
    this.accounts.push(account);
    this.prepare(account);
    this.config.activeAccountId ??= id;
    this.save();
    return account;
  }

  remove(ref) {
    const acct = this.find(ref);
    if (!acct) throw new Error(`No account "${ref}"`);
    this.config.accounts = this.accounts.filter((a) => a !== acct);
    delete this.state.accounts[acct.id];
    if (this.config.activeAccountId === acct.id) this.config.activeAccountId = this.accounts[0]?.id ?? null;
    fs.rmSync(paths.accountDir(acct.id), { recursive: true, force: true });
    this.save();
    return acct;
  }

  /** Create the account's private Claude Code profile dir, with shared pieces symlinked in. */
  prepare(account) {
    ensureSharedLayout();
    const dir = paths.accountDir(account.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    linkShared(dir);
    return dir;
  }

  /** Environment for a `claude` child process running as this account. */
  envFor(account, base = process.env) {
    const env = { ...base };
    for (const k of AUTH_ENV) delete env[k];
    env.CLAUDE_CONFIG_DIR = this.prepare(account);
    if (account.type === 'api') env.ANTHROPIC_API_KEY = account.secret;
    if (account.type === 'token') env.CLAUDE_CODE_OAUTH_TOKEN = account.secret;
    return env;
  }

  isAvailable(account, now = Date.now()) {
    if (!account.enabled) return false;
    const s = this.stateOf(account.id);
    return !s.limitedUntil || s.limitedUntil <= now;
  }

  available(now = Date.now()) {
    return this.accounts.filter((a) => this.isAvailable(a, now));
  }

  get active() {
    return this.find(this.config.activeAccountId) || this.accounts[0] || null;
  }

  setActive(ref) {
    const acct = this.find(ref);
    if (!acct) throw new Error(`No account "${ref}"`);
    this.config.activeAccountId = acct.id;
    this.save();
    return acct;
  }

  /** The next available account after `fromId` in pool order (wrapping), or null. */
  nextAvailable(fromId, now = Date.now()) {
    const list = this.accounts;
    if (!list.length) return null;
    const start = Math.max(0, list.findIndex((a) => a.id === fromId));
    for (let i = 1; i <= list.length; i++) {
      const cand = list[(start + i) % list.length];
      if (this.isAvailable(cand, now)) return cand;
    }
    return null;
  }

  /** Account to use for the next turn, per strategy. Null means "everything is limited". */
  pick(now = Date.now()) {
    const active = this.active;
    if (!active) return null;
    if (this.settings.strategy === 'wait') return this.isAvailable(active, now) ? active : null;
    if (this.isAvailable(active, now)) return active;
    return this.nextAvailable(active.id, now);
  }

  /** When the earliest limited (but enabled) account frees up. */
  earliestReset() {
    const times = this.accounts
      .filter((a) => a.enabled)
      .map((a) => this.stateOf(a.id).limitedUntil)
      .filter(Boolean);
    return times.length ? Math.min(...times) : null;
  }

  markLimited(id, until, reason) {
    const s = this.stateOf(id);
    s.limitedUntil = until;
    s.lastError = reason || 'usage limit reached';
    this.save();
  }

  clearLimit(ref) {
    const acct = this.find(ref);
    if (!acct) throw new Error(`No account "${ref}"`);
    Object.assign(this.stateOf(acct.id), { limitedUntil: null, lastError: null });
    this.save();
    return acct;
  }

  setEnabled(ref, enabled, reason = null) {
    const acct = this.find(ref);
    if (!acct) throw new Error(`No account "${ref}"`);
    acct.enabled = enabled;
    this.stateOf(acct.id).lastError = reason;
    this.save();
    return acct;
  }

  recordTurn(id, { costUsd = 0, windows } = {}) {
    const s = this.stateOf(id);
    s.turns += 1;
    s.costUsd = Math.round((s.costUsd + (costUsd || 0)) * 1e6) / 1e6;
    s.lastUsed = Date.now();
    s.lastError = null;
    if (windows && Object.keys(windows).length) s.windows = windows;
    this.save();
  }

  /** Public, secret-free view for UIs. */
  describe(now = Date.now()) {
    return this.accounts.map((a) => {
      const s = this.stateOf(a.id);
      const limited = Boolean(s.limitedUntil && s.limitedUntil > now);
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        secret: mask(a.secret),
        enabled: a.enabled,
        active: a.id === this.active?.id,
        status: !a.enabled ? 'disabled' : limited ? 'limited' : 'ready',
        limitedUntil: limited ? s.limitedUntil : null,
        lastError: s.lastError,
        lastUsed: s.lastUsed,
        turns: s.turns,
        costUsd: s.costUsd,
        windows: s.windows || {},
      };
    });
  }
}
