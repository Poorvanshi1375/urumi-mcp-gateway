// WooCommerce MCP server: Streamable HTTP at /mcp (MCP TS SDK v2 via Fastify, as proven in V3).
// Cluster-internal only (ClusterIP + NetworkPolicy); every MCP request must carry the bearer
// token that only the gateway holds.
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createWooClient, describeWooError } from './woo.ts';
import { registerWooTools } from './tools.ts';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

const config = {
  port: Number(env('PORT', '8080')),
  bearerToken: env('MCP_BEARER_TOKEN'),
  woo: {
    signingBaseUrl: env('WC_SIGNING_BASE_URL'),
    connectHost: process.env.WC_CONNECT_HOST || undefined,
    consumerKey: env('WC_CONSUMER_KEY'),
    consumerSecret: env('WC_CONSUMER_SECRET'),
    timeoutMs: Number(env('WC_TIMEOUT_MS', '15000')),
  },
};

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, disableRequestLogging: true });
const woo = createWooClient(config.woo);
const logTool = (tool: string, ms: number, outcome: string, detail?: string) =>
  app.log.info({ tool, ms, outcome, detail }, 'tool call');

const mcp = createMcpHandler(() => {
  const server = new McpServer({ name: 'urumi-woo-mcp', version: '0.1.0' });
  registerWooTools(server, woo, logTool);
  return server;
});
const mcpNode = toNodeHandler(mcp, { onerror: e => app.log.error(e, 'mcp adapter error') });

const expected = Buffer.from(config.bearerToken);
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

// Liveness: the process serves HTTP. Readiness: the store answers a signed request, cached
// briefly so probes don't hammer WordPress. A signing-URL mismatch shows up here as a 401.
app.get('/healthz', async () => ({ ok: true }));
let ready: { at: number; ok: boolean; detail: string } = { at: 0, ok: false, detail: 'not checked yet' };
app.get('/readyz', async (_req, reply) => {
  if (Date.now() - ready.at > 10_000) {
    try {
      await woo.get('products', { per_page: 1, _fields: 'id' });
      ready = { at: Date.now(), ok: true, detail: 'woocommerce reachable' };
    } catch (err) {
      ready = { at: Date.now(), ok: false, detail: describeWooError(err) };
      app.log.warn({ detail: ready.detail }, 'readiness check failed');
    }
  }
  return reply.code(ready.ok ? 200 : 503).send({ ok: ready.ok, detail: ready.detail });
});

const shutdown = async () => { await app.close(); await mcp.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info({ signingBaseUrl: config.woo.signingBaseUrl, connectHost: config.woo.connectHost ?? null }, 'woo-mcp ready');
