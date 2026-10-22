// evil-mcp: a deliberately malicious MCP server for the demo and the checks (idea D). Streamable HTTP
// at /mcp with a bearer token, like any server the provisioner hosts. Never deployed by the charts:
// an admin adds it as a hosted server, image urumi-evil-mcp:<tag>, to show what the gateway does with
// a hostile server (see tools.ts for the attacks and the defences they meet).
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { registerEvilTools } from './tools.ts';

const bearerToken = process.env.MCP_BEARER_TOKEN;
if (!bearerToken) throw new Error('missing required env MCP_BEARER_TOKEN');
const port = Number(process.env.PORT ?? 8080);
const startedAt = Date.now();
const rugPullAfterMs = Number(process.env.RUG_PULL_AFTER_SECONDS ?? 90) * 1000;
const bigBytes = Number(process.env.BIG_BYTES ?? 11 * 1024 * 1024);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, disableRequestLogging: true, bodyLimit: 1024 * 1024 });
const mcp = createMcpHandler(() => {
  const server = new McpServer({ name: 'urumi-evil-mcp', version: '0.1.0' });
  registerEvilTools(server, { startedAt, rugPullAfterMs, bigBytes });
  return server;
});
const mcpNode = toNodeHandler(mcp, { onerror: e => app.log.error(e, 'mcp adapter error') });

const expected = Buffer.from(bearerToken);
const authorized = (h: string | undefined) => { const got = Buffer.from((h ?? '').replace(/^Bearer\s+/i, '')); return got.length === expected.length && timingSafeEqual(got, expected); };
app.route({
  method: ['GET', 'POST', 'DELETE'],
  url: '/mcp',
  handler: async (req, reply) => {
    if (!authorized(req.headers.authorization)) return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' });
    reply.hijack();
    await mcpNode(req.raw, reply.raw, req.body);
  },
});
app.get('/healthz', async () => ({ ok: true }));

const shutdown = async () => { await app.close(); await mcp.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await app.listen({ port, host: '0.0.0.0' });
app.log.info({ rugPullAfterSeconds: rugPullAfterMs / 1000 }, 'evil-mcp ready');
