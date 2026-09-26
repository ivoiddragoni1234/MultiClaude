// A tiny MCP server (stdio) that Claude Code starts for each MultiClaude conversation. It lets the
// main agent tidy up its subagents: list them, delete finished ones, and save findings to memory.
// It talks to the running MultiClaude app over its local HTTP API.
import readline from 'node:readline';
import { VERSION } from './version.js';

const TOOLS = [
  {
    name: 'subagents_list',
    description: 'List the subagent conversations of this chat that the user can see in the MultiClaude sidebar, with their status (running, done, failed, stopped) and agentId.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'subagent_delete',
    description: 'Delete a finished subagent conversation from the sidebar and from disk. Save anything worth keeping with the remember tool first. You cannot resume a deleted subagent.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'The agentId (or the Agent tool call id) of the subagent to delete' } },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'remember',
    description: 'Save a note to MultiClaude long-term memory (the shared CLAUDE.md loaded into every future conversation). Use for durable facts, decisions and findings — not secrets.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'The note to save, concise and self-contained' } },
      required: ['note'],
      additionalProperties: false,
    },
  },
];

async function call(method, route, body) {
  const base = process.env.MULTICLAUDE_URL;
  const session = process.env.MULTICLAUDE_SESSION;
  const res = await fetch(`${base}${route.replace(':session', encodeURIComponent(session))}`, {
    method,
    headers: { 'x-token': process.env.MULTICLAUDE_TOKEN || '', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `MultiClaude returned ${res.status}`);
  return data;
}

async function runTool(name, args = {}) {
  if (name === 'subagents_list') {
    const { subagents } = await call('GET', '/api/sessions/:session/subagents');
    if (!subagents.length) return 'No subagent conversations.';
    return subagents.map((s) => `- ${s.agentId || s.id} [${s.status}] ${s.type}: ${s.description}`).join('\n');
  }
  if (name === 'subagent_delete') {
    await call('DELETE', `/api/sessions/:session/subagents/${encodeURIComponent(String(args.agent || ''))}`);
    return `Deleted subagent ${args.agent}.`;
  }
  if (name === 'remember') {
    await call('POST', '/api/memory/append', { note: String(args.note || '') });
    return 'Saved to memory.';
  }
  throw new Error(`Unknown tool ${name}`);
}

export function runMcpServer() {
  const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params = {} } = msg;
    if (id === undefined) return; // notifications
    const reply = (result) => out({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: params.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'multiclaude', version: VERSION },
          });
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: TOOLS });
        case 'tools/call':
          try {
            const text = await runTool(params.name, params.arguments);
            return reply({ content: [{ type: 'text', text }] });
          } catch (err) {
            return reply({ content: [{ type: 'text', text: err.message }], isError: true });
          }
        default:
          return fail(-32601, `Method not found: ${method}`);
      }
    } catch (err) {
      return fail(-32603, err.message);
    }
  });
  rl.on('close', () => process.exit(0));
}
