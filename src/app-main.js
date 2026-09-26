import { main } from './app.js';
import { runMcpServer } from './mcp.js';

// MultiClaude.exe --mcp is started by Claude Code as the MultiClaude tools server.
if (process.argv.includes('--mcp')) runMcpServer();
else main();
