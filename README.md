# MultiClaude

A personal Claude gateway, inspired by OpenClaw. You sign in as many accounts as you like, Claude subscriptions or Anthropic API keys, and MultiClaude runs **the real Claude Code** on them. When one account hits its usage limit, it moves the same conversation to the next account. When every account is used up, it waits for the first one to reset and then carries on.

- **Everything Claude Code can do.** MultiClaude drives the official `claude` CLI, so Bash, file edits, MCP servers, subagents, skills, plugins and slash commands all work. `multiclaude tui` opens the full Claude Code interface itself.
- **Seamless failover.** Session transcripts are shared between accounts, so the next account resumes the same conversation with `--resume` and picks up an interrupted turn where it stopped.
- **Rotation strategies.** `failover` stays on one account until it runs out, then moves to the next and wraps around. `round-robin` switches accounts after every turn. `wait` never switches and waits for the current account to reset.
- **Waits instead of failing.** When all accounts are limited, it counts down to the earliest reset and continues. Set `onAllLimited` to `stop` if you would rather it stopped.
- **Switches before hitting the wall.** It reads Claude Code's rate-limit events and retires an account once a usage window is 97% full (`switchAtUtilization`).
- **Persistent memory.** A shared `CLAUDE.md` loads into every session on every account. Claude is told it can append to this file, and you can manage it with `/remember`, `/memory` and `/forget` or edit it in the dashboard.
- **Claude Code–style web app.** `multiclaude web` opens a local site laid out like Claude Code: a sessions sidebar, streaming chat, tool cards with diffs and output, subagents shown with their own nested tool calls, todo lists, and model, effort and permission pickers. Accounts switch silently in the middle of a turn, with no restart and no pop-up. Past sessions reload from Claude Code's own transcripts.
- Zero dependencies. You only need Node 18+ and Claude Code.

## Windows app (no terminal needed)

1. Install **Claude Code** once: open PowerShell and run `irm https://claude.ai/install.ps1 | iex`. On Windows, Claude Code uses Git for Windows for its Bash tool; if it's missing, Claude Code's installer or first run tells you.
2. Double-click **MultiClaude.exe**. Get it from this repo's *Releases* page, from the *Windows app* workflow's artifacts, or build it yourself with `npm run build:exe`. It opens in its own window with no console.
3. Open **Accounts**, then **Add account** and **Get a token…**. Sign in with each Pro/Max account and paste its token.
4. Click **New session**, pick the folder you want Claude to work in, and start chatting.

The app runs a small local server in the background. It is only reachable from your own PC and is protected by a private token. Close every MultiClaude window and it quits by itself once Claude has finished any running task. Logs are in `%USERPROFILE%\.multiclaude\logs\app.log`.

Windows may show a SmartScreen warning the first time, because the exe isn't code-signed. Click *More info → Run anyway*.

## Install (command line, any OS)

```bash
npm i -g @anthropic-ai/claude-code      # if you don't have Claude Code yet
git clone https://github.com/ivoiddragoni1234/MultiClaude && cd MultiClaude
npm link                                # puts `multiclaude` on your PATH
```

## Add accounts

```bash
# Anthropic API key (prompts for the key if you leave it off)
multiclaude add work-api --api-key

# Claude Pro/Max subscription: long-lived token (recommended for subscriptions)
claude setup-token                      # run once while signed in to that account, copy the token
multiclaude add personal-max --token

# Claude subscription signed in to its own isolated profile
multiclaude add team-max --login
multiclaude login team-max              # opens the normal Claude sign-in flow

multiclaude accounts                    # status, limits, reset countdowns, usage
```

Each account gets its own Claude Code profile (`CLAUDE_CONFIG_DIR`) under `~/.multiclaude/accounts/<id>`. Credentials never mix between accounts. Transcripts, memory, `settings.json`, agents, commands, skills and plugins are symlinked from `~/.multiclaude/shared`, so every account sees the same setup.

## Use it

```bash
multiclaude                             # chat in the terminal (Ctrl+C stops a turn)
multiclaude run "fix the failing tests" # one-shot, pipe-friendly
multiclaude tui                         # full Claude Code UI, resumes on the next account when one runs out
multiclaude tui --auto -- --model opus  # continue without asking; pass extra args to claude
multiclaude web                         # Claude Code–style web app at http://127.0.0.1:7878 (open the printed link)
```

Chat commands: `/accounts`, `/use <name>`, `/strategy <s>`, `/reset <name>`, `/new`, `/remember <text>`, `/memory`, `/forget`, `/status`, `/tui`, `/quit`.

## The web app

Run `multiclaude web` and open the link it prints. The link includes a private access token.

- **New session** picks a working folder. Each session is a real Claude Code conversation, and several can run at once.
- Account switching is silent. If an account runs out mid-task, the next one resumes the same conversation and finishes the work. The chat just keeps streaming. Turn on *Rotation → Show account switches in the chat* if you want to see it happen. The only time you'll see a message is when every account is used up; then a bar counts down to the next reset and it continues on its own.
- **Accounts** (sidebar, or click your name at the bottom) lets you add Pro/Max tokens or API keys, see usage per window, pause accounts or clear a limit.
- **Memory** edits the shared `CLAUDE.md` that every session loads.
- The picker at the bottom left is the permission mode. The web app can't show approval prompts, so pick **Auto** or **Bypass permissions** if you want Claude to run shell commands freely. **Accept edits** allows file edits only.

## Settings

```bash
multiclaude strategy round-robin
multiclaude set onAllLimited wait              # or stop
multiclaude set switchAtUtilization 0.95       # 1 = never switch early
multiclaude set permissionMode bypassPermissions
multiclaude set model opus
multiclaude config
```

`permissionMode` defaults to `acceptEdits`. In chat and web mode Claude runs headless and cannot ask you for permission, so any tool call that would need a prompt is denied. To give Claude full terminal access (Bash included), use `bypassPermissions`, but only in a directory or machine you trust. You can also use `multiclaude tui`, which shows the normal permission prompts.

## How it works

1. Each turn runs `claude -p --output-format stream-json --resume <session>` with the active account's credentials.
2. MultiClaude watches the stream for `rate_limit_event`s and error results such as "usage limit reached", "resets 3pm", 429 or 529.
3. When an account hits its limit, it is marked limited until its reset time. The next available account resumes the same session and is asked to continue the interrupted work.
4. Invalid keys and accounts with no credit are disabled automatically. `multiclaude enable <name>` turns them back on. Overloaded errors are retried with backoff.
5. When nothing is available, MultiClaude sleeps until the earliest reset, or until the current account's reset under the `wait` strategy.

All data lives in `~/.multiclaude` (override with `MULTICLAUDE_HOME`). `config.json` holds your keys and is written with `0600` permissions.

The dashboard only listens on 127.0.0.1 and needs the random token in the printed link. Anyone with that link can run commands through Claude, so keep it private.

## Terms of service

Check that your use follows [Anthropic's terms](https://www.anthropic.com/legal). API keys are billed per use and are the supported way to add capacity. Anthropic's consumer terms for Claude.ai subscriptions do not allow sharing accounts or using several accounts to get around usage limits. Only add subscription accounts that you are entitled to use this way, such as separate work and personal plans you each pay for.

## Development

```bash
npm test    # unit + integration tests against a fake `claude` binary (test/fake-claude.js)
```
