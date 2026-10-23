// The same shipping tools over stdio, one JSON-RPC message per line on stdin and stdout (logs go to
// stderr). Used to show hosted stdio servers (P12): the platform runs this command behind its
// mcp-bridge, which serves it over HTTP to the gateway.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerShipTools } from './tools.ts';

const server = new McpServer({ name: 'urumi-ship-mcp-stdio', version: '0.1.0' });
registerShipTools(server, { latencyMs: 0, log: (tool, ms, outcome) => console.error(JSON.stringify({ tool, ms, outcome })) });
await server.connect(new StdioServerTransport());
