// Shipping MCP server: Streamable HTTP at /mcp, same shape as woo-mcp (Fastify + MCP TS SDK v2).
// Cluster-internal only; every MCP request must carry the bearer token that only the gateway holds.
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { registerShipTools } from './tools.ts';

const bearerToken = process.env.MCP_BEARER_TOKEN;
if (!bearerToken) throw new Error('missing required env MCP_BEARER_TOKEN');
const port = Number(process.env.PORT ?? 8080);
// Test knob for gateway timeout handling (G4): delay every tool call by this many ms.
const latencyMs = Number(process.env.SIMULATED_LATENCY_MS ?? 0);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, disableRequestLogging: true });
const log = (tool: string, ms: number, outcome: string, detail?: string) => app.log.info({ tool, ms, outcome, detail }, 'tool call');

const mcp = createMcpHandler(() => {
  const server = new McpServer({ name: 'urumi-ship-mcp', version: '0.1.0' });
  registerShipTools(server, { latencyMs, log });
  return server;
});
const mcpNode = toNodeHandler(mcp, { onerror: e => app.log.error(e, 'mcp adapter error') });

const expected = Buffer.from(bearerToken);
function authorized(header: string | undefined): boolean {
  const got = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
  return got.length === expected.length && timingSafeEqual(got, expected);
}

app.route({
  method: ['GET', 'POST', 'DELETE'],
  url: '/mcp',
  handler: async (req, reply) => {
    if (!authorized(req.headers.authorization)) {
      app.log.warn({ ip: req.ip }, 'rejected MCP request: bad or missing bearer token');
      return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' });
    }
    reply.hijack();
    await mcpNode(req.raw, reply.raw, req.body);
  },
});

app.get('/healthz', async () => ({ ok: true }));
app.get('/readyz', async () => ({ ok: true, simulatedLatencyMs: latencyMs }));

const shutdown = async () => { await app.close(); await mcp.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port, host: '0.0.0.0' });
app.log.info({ simulatedLatencyMs: latencyMs }, 'ship-mcp ready');
