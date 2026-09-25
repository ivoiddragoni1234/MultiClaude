import readline from 'node:readline';
import { Orchestrator } from './orchestrator.js';
import { STRATEGIES } from './accounts.js';
import { readMemory, remember, forgetAll } from './memory.js';
import { runTui } from './tui.js';
import { paths } from './paths.js';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

export function printAccounts(pool) {
  const rows = pool.describe();
  if (!rows.length) {
    console.log('No accounts yet. Add one: multiclaude add <name> --api-key | --token | --login');
    return;
  }
  for (const [i, a] of rows.entries()) {
    const status = a.status === 'ready' ? c.green('ready')
      : a.status === 'limited' ? c.yellow(`limited, resets in ${fmtDuration(a.limitedUntil - Date.now())}`)
      : c.red('disabled');
    const use = Object.entries(a.windows).map(([k, w]) => `${k} ${Math.round((w.utilization ?? 0) * 100)}%`).join(', ');
    console.log(`${a.active ? c.cyan('▶') : ' '} ${i + 1}. ${c.bold(a.name)} ${c.dim(`[${a.id}] ${a.type} ${a.secret}`)}  ${status}` +
      c.dim(`  turns ${a.turns}${a.costUsd ? `, $${a.costUsd.toFixed(2)}` : ''}${use ? `, ${use}` : ''}`) +
      (a.lastError && a.status !== 'ready' ? c.dim(`\n      ${a.lastError}`) : ''));
  }
}

function toolSummary(name, input = {}) {
  const v = input.command || input.file_path || input.pattern || input.url || input.description || input.prompt || '';
  return `${name}${v ? `: ${String(v).split('\n')[0].slice(0, 100)}` : ''}`;
}

const HELP = `
Type a message to talk to Claude. Commands:
  /accounts            list accounts and their limits      /use <name|#>   switch account
  /strategy <s>        ${Object.keys(STRATEGIES).join(' | ')}
  /reset <name>        clear an account's limit            /new            start a new conversation
  /remember <text>     save a note to long-term memory     /memory         show memory
  /forget              wipe memory                         /status         session info
  /tui                 open this conversation in the full Claude Code UI
  /quit                exit            (Ctrl+C stops the current turn)
`;

export async function startRepl(pool, { sessionId = null } = {}) {
  const orch = new Orchestrator(pool, { sessionId });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.cyan('you › ') });
  let waitingLine = false;
  let atLineStart = true;

  const clearWait = () => { if (waitingLine) { process.stdout.write('\r\x1b[K'); waitingLine = false; } };
  const note = (s) => { clearWait(); if (!atLineStart) process.stdout.write('\n'); atLineStart = true; console.log(s); };

  orch.on('account', ({ account }) => note(c.dim(`[${account.name}]`)));
  orch.on('switch', ({ from, to }) => note(c.yellow(`↻ switching ${from ? `from "${from.name}" ` : ''}to "${to.name}"`)));
  orch.on('limited', ({ account, until, message }) => note(c.yellow(`⚠ "${account.name}": ${message} — resets ${new Date(until).toLocaleString()}`)));
  orch.on('retry', ({ attempt, delayMs }) => note(c.yellow(`API overloaded, retry ${attempt} in ${fmtDuration(delayMs)}`)));
  orch.on('notice', (err) => note(c.red(err.message)));
  orch.on('waiting', ({ until, msLeft }) => {
    process.stdout.write(`\r\x1b[K${c.yellow(`⏳ all accounts limited — resuming in ${fmtDuration(msLeft)} (${new Date(until).toLocaleTimeString()}), Ctrl+C to cancel`)}`);
    waitingLine = true;
  });
  orch.on('event', (ev) => {
    if (ev.type === 'text') {
      clearWait();
      process.stdout.write(ev.text);
      atLineStart = ev.text.endsWith('\n');
    } else if (ev.type === 'tool') {
      note(c.dim(`${ev.subagent ? '  ↳ ' : '⚙ '}${toolSummary(ev.name, ev.input)}`));
    }
  });

  rl.on('SIGINT', () => {
    if (orch.busy) { orch.stop(); note(c.dim('(stopping…)')); } else { rl.close(); }
  });

  const active = pool.active;
  console.log(c.bold('MultiClaude') + c.dim(` — ${pool.accounts.length} account(s), strategy ${pool.settings.strategy}, active: ${active?.name ?? 'none'}. /help for commands.`));
  if (sessionId) console.log(c.dim(`resuming session ${sessionId}`));
  rl.prompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) { rl.prompt(); continue; }
    try {
      if (line.startsWith('/')) {
        const [cmd, ...rest] = line.slice(1).split(/\s+/);
        const arg = rest.join(' ');
        switch (cmd) {
          case 'help': console.log(HELP); break;
          case 'quit': case 'exit': rl.close(); return;
          case 'accounts': pool.load(); printAccounts(pool); break;
          case 'use': pool.load(); console.log(`Active account: ${pool.setActive(arg).name}`); break;
          case 'reset': pool.load(); console.log(`Cleared limit on ${pool.clearLimit(arg).name}`); break;
          case 'strategy':
            if (!STRATEGIES[arg]) throw new Error(`Strategies: ${Object.entries(STRATEGIES).map(([k, v]) => `\n  ${k} — ${v}`).join('')}`);
            pool.load(); pool.settings.strategy = arg; pool.save(); console.log(`Strategy: ${arg}`); break;
          case 'new': orch.newConversation(); console.log('Started a new conversation.'); break;
          case 'remember': console.log(`Remembered: ${remember(arg)}`); break;
          case 'memory': console.log(readMemory()); console.log(c.dim(paths.memory)); break;
          case 'forget': forgetAll(); console.log('Memory cleared.'); break;
          case 'status':
            console.log(`session: ${orch.sessionId ?? '(new)'}\ncwd: ${orch.cwd}\nstrategy: ${pool.settings.strategy}, permission mode: ${pool.settings.permissionMode}`);
            break;
          case 'tui':
            rl.pause();
            await runTui(pool, { sessionId: orch.sessionId });
            rl.resume();
            break;
          default: console.log(`Unknown command /${cmd}. Type /help.`);
        }
      } else {
        // readline stays live during the turn so Ctrl+C reaches the SIGINT handler above
        await orch.send(line);
        if (!atLineStart) process.stdout.write('\n');
        atLineStart = true;
      }
    } catch (err) {
      clearWait();
      console.log(c.red(err.message === 'aborted' ? 'Cancelled.' : err.message));
    }
    rl.prompt();
  }
}
