#!/usr/bin/env node
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { AccountPool, STRATEGIES, DEFAULT_SETTINGS } from '../src/accounts.js';
import { Orchestrator } from '../src/orchestrator.js';
import { startRepl, printAccounts } from '../src/repl.js';
import { runTui } from '../src/tui.js';
import { startServer } from '../src/server.js';
import { readMemory, remember, forgetAll } from '../src/memory.js';
import { paths } from '../src/paths.js';

const HELP = `MultiClaude — run Claude Code across many accounts with automatic failover.

Usage: multiclaude [command] [options]

Chat
  (no command)                      interactive chat that rotates accounts automatically
  chat [--resume <session>]         same as above
  run "<prompt>"                    one-shot prompt (pipe-friendly), with failover
  tui [--auto] [-- <claude args>]   full Claude Code UI; resumes on the next account when one runs out
  web [--port 7878]                 Claude Code–style web app with silent account switching

Accounts
  add <name> --api-key [key]        Anthropic API key
  add <name> --token [token]        subscription token from \`claude setup-token\`
  add <name> --login                subscription signed in to its own profile (then: multiclaude login <name>)
  login <name>                      run \`claude auth login\` inside that account's profile
  accounts | ls                     list accounts, limits and usage
  use <name|#>                      make an account active
  remove <name>                     delete an account
  enable|disable <name>             include/exclude an account from rotation
  reset <name|all>                  clear a recorded limit

Settings
  strategy [failover|round-robin|wait]
  set <key> <value>                 ${Object.keys(DEFAULT_SETTINGS).join(', ')}
  config                            print settings

Memory
  memory                            show long-term memory
  remember "<note>"                 add a note
  forget                            wipe memory

Data lives in ${paths.home} (override with MULTICLAUDE_HOME).`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : true;
}

async function askSecret(question) {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (s) => (s.includes(question) ? write(s) : write?.(s.replace(/[^\r\n]/g, '*')));
  const answer = await rl.question(question);
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

function coerce(key, value) {
  const def = DEFAULT_SETTINGS[key];
  if (def === undefined) throw new Error(`Unknown setting "${key}". Settings: ${Object.keys(DEFAULT_SETTINGS).join(', ')}`);
  if (typeof def === 'number') {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`${key} must be a number`);
    return n;
  }
  if (Array.isArray(def)) return value ? value.split(/\s+/) : [];
  return value ?? '';
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'chat';
  if (cmd === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  const pool = new AccountPool();

  switch (cmd) {
    case 'chat': {
      await startRepl(pool, { sessionId: flag(args, '--resume') || null });
      break;
    }
    case 'run': {
      let prompt = args.join(' ');
      if (!prompt && !process.stdin.isTTY) for await (const chunk of process.stdin) prompt += chunk;
      if (!prompt.trim()) throw new Error('Usage: multiclaude run "<prompt>"');
      const orch = new Orchestrator(pool);
      orch.on('event', (ev) => { if (ev.type === 'text') process.stdout.write(ev.text); });
      orch.on('switch', ({ to }) => console.error(`[multiclaude] switched to "${to.name}"`));
      orch.on('limited', ({ account, until }) => console.error(`[multiclaude] "${account.name}" limited until ${new Date(until).toLocaleString()}`));
      orch.on('notice', (err) => console.error(`[multiclaude] ${err.message}`));
      let lastWaitLog = 0;
      orch.on('waiting', ({ until }) => {
        if (Date.now() - lastWaitLog > 60000) { lastWaitLog = Date.now(); console.error(`[multiclaude] all accounts limited, waiting until ${new Date(until).toLocaleString()}`); }
      });
      process.on('SIGINT', () => orch.stop());
      const r = await orch.send(prompt);
      if (r.aborted) process.exitCode = 130;
      break;
    }
    case 'tui': {
      const dd = args.indexOf('--');
      const extra = dd === -1 ? [] : args.splice(dd).slice(1);
      await runTui(pool, { auto: Boolean(flag(args, '--auto')), sessionId: flag(args, '--resume') || null, extraArgs: extra });
      break;
    }
    case 'web': {
      const port = Number(flag(args, '--port') || 7878);
      const host = flag(args, '--host') || '127.0.0.1';
      const { url } = await startServer(pool, { port, host: host === true ? '127.0.0.1' : host });
      console.log(`MultiClaude dashboard: ${url}\n(keep this link private — it grants control of Claude on this machine)`);
      break;
    }
    case 'add': {
      const name = args.shift();
      if (!name) throw new Error('Usage: multiclaude add <name> --api-key [key] | --token [token] | --login');
      const apiKey = flag(args, '--api-key');
      const token = flag(args, '--token');
      const login = flag(args, '--login');
      const type = apiKey ? 'api' : token ? 'token' : login ? 'login' : null;
      if (!type) throw new Error('Pick one of --api-key, --token or --login');
      let secret = type === 'api' ? apiKey : type === 'token' ? token : null;
      if (secret === true) secret = await askSecret(type === 'api' ? 'Anthropic API key: ' : 'Token from `claude setup-token`: ');
      const acct = pool.add({ name, type, secret });
      console.log(`Added "${acct.name}" (${acct.id}, ${type}).`);
      if (type === 'login') console.log(`Now sign in: multiclaude login ${acct.id}`);
      break;
    }
    case 'login': {
      const acct = pool.find(args[0]);
      if (!acct) throw new Error('Usage: multiclaude login <name>  (add it first with --login)');
      const extra = args.includes('--console') ? ['--console'] : [];
      const code = await new Promise((resolve, reject) => {
        const child = spawn(pool.settings.claudePath, ['auth', 'login', ...extra], { stdio: 'inherit', env: pool.envFor(acct) });
        child.on('error', reject);
        child.on('close', resolve);
      });
      if (code !== 0) throw new Error('Login did not complete');
      console.log(`"${acct.name}" is signed in. Its profile lives in ${paths.accountDir(acct.id)}`);
      break;
    }
    case 'accounts': case 'ls': case 'list': printAccounts(pool); break;
    case 'use': console.log(`Active: ${pool.setActive(args[0]).name}`); break;
    case 'remove': case 'rm': console.log(`Removed ${pool.remove(args[0]).name}`); break;
    case 'enable': console.log(`Enabled ${pool.setEnabled(args[0], true).name}`); break;
    case 'disable': console.log(`Disabled ${pool.setEnabled(args[0], false, 'disabled by you').name}`); break;
    case 'reset': {
      const targets = args[0] === 'all' ? pool.accounts.map((a) => a.id) : [args[0]];
      for (const t of targets) console.log(`Cleared limit on ${pool.clearLimit(t).name}`);
      break;
    }
    case 'strategy': {
      if (!args[0]) {
        for (const [k, v] of Object.entries(STRATEGIES)) console.log(`${k === pool.settings.strategy ? '▶' : ' '} ${k.padEnd(12)} ${v}`);
        break;
      }
      if (!STRATEGIES[args[0]]) throw new Error(`Unknown strategy. Use: ${Object.keys(STRATEGIES).join(', ')}`);
      pool.settings.strategy = args[0];
      pool.save();
      console.log(`Strategy: ${args[0]}`);
      break;
    }
    case 'set': {
      const [key, ...rest] = args;
      pool.settings[key] = coerce(key, rest.join(' '));
      pool.save();
      console.log(`${key} = ${JSON.stringify(pool.settings[key])}`);
      break;
    }
    case 'config': console.log(JSON.stringify(pool.settings, null, 2)); break;
    case 'memory': console.log(readMemory()); break;
    case 'remember': console.log(`Remembered: ${remember(args.join(' '))}`); break;
    case 'forget': forgetAll(); console.log('Memory cleared.'); break;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`multiclaude: ${err.message}`);
  process.exit(1);
});
