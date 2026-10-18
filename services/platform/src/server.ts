// Platform server: the MCP gateway at /mcp and the dashboard API at /api (chat and UI follow in M4).
import Fastify from 'fastify';
import http from 'node:http';
import os from 'node:os';
import cookie from '@fastify/cookie';
import pg from 'pg';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadConfig } from './config.ts';
import { createDb, REGISTRY_CHANNEL } from './db/client.ts';
import { createCredentialCipher } from './lib/crypto.ts';
import { bootstrap } from './bootstrap.ts';
import { authenticate } from './gateway/auth.ts';
import { createGatewayCore, createGatewayHandler } from './gateway/mcp.ts';
import { Permissions } from './services/permissions.ts';
import { Pinning } from './services/pins.ts';
import { SEPARATOR, UpstreamManager, describeError } from './gateway/upstream-manager.ts';
import { registerApi } from './api/routes.ts';
import { createGuardedFetch, policyFromEnv } from './lib/ssrf.ts';
import { registerWeb } from './web.ts';
import { rejected, renderMetrics } from './lib/metrics.ts';
import { RateLimiter } from './lib/ratelimit.ts';

const config = loadConfig();
// trustProxy: behind Traefik, req.protocol reflects X-Forwarded-Proto (secure cookies on HTTPS).
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, disableRequestLogging: true, trustProxy: true });
// Which replica answered, so load balancing across gateway pods is visible to clients and tests.
const REPLICA = os.hostname();
app.addHook('onRequest', async (_req, reply) => { reply.header('x-gateway-replica', REPLICA); });
const mcpLimiter = new RateLimiter(config.rateLimit.perMinute, config.rateLimit.burst);
await app.register(cookie);
const { pool, db } = createDb();
const cipher = createCredentialCipher(config.encryptionSecret);

let mcp: ReturnType<typeof createGatewayHandler>;
const ssrf = policyFromEnv();
const pinning = new Pinning(db, config.features.toolPinning);
app.log.info({ features: config.features }, 'feature flags');
if (ssrf.disabled) app.log.warn('SSRF guard is OFF (SSRF_GUARD=off): only for local development');
const manager = new UpstreamManager(db, cipher, { ...config, fetch: createGuardedFetch(ssrf), pinning: pinning.enabled ? pinning : undefined }, () => mcp?.notify.toolsChanged(), app.log);
const perms = new Permissions(db);
const core = createGatewayCore({ db, manager, perms, log: app.log });
mcp = createGatewayHandler(core, { toolSearch: config.features.toolSearch });
const mcpNode = toNodeHandler(mcp, { onerror: e => app.log.error({ err: describeError(e) }, 'mcp adapter error') });

// Readiness: bootstrap succeeded (so the schema exists) and Postgres answers. On a fresh install the
// app starts before the post-install migration Job has run, so bootstrap retries until it can.
let bootstrapped = false;
async function bootstrapWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await bootstrap(db, cipher, config.bootstrap, app.log);
      await perms.load();
      await pinning.load();
      bootstrapped = true;
      return;
    } catch (e) {
      app.log.warn({ attempt, err: describeError(e) }, 'bootstrap not possible yet (database or schema not ready); retrying');
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// Registry changes (CLI, dashboard, other replicas) arrive as Postgres NOTIFY; the health loop's
// periodic reload is the fallback if this connection drops.
async function listenForRegistryChanges() {
  const client = new pg.Client();
  let retrying = false;
  const retry = (e: unknown) => {
    if (retrying) return;   // a failed connect can surface both as an 'error' event and a rejection
    retrying = true;
    app.log.warn({ err: describeError(e) }, 'registry LISTEN connection lost; reconnecting in 5 s');
    void client.end().catch(() => {});
    setTimeout(() => void listenForRegistryChanges(), 5000);
  };
  client.on('error', retry);
  client.on('notification', n => {
    if (n.payload?.startsWith('recheck:')) {
      manager.recheck(n.payload.slice('recheck:'.length));
    } else if (n.payload === 'pins') {
      // Another replica (or this one) approved a tool: reload pins and re-filter without network calls.
      void pinning.load().then(() => manager.reapplyPins()).catch(e => app.log.warn({ err: describeError(e) }, 'pin reload failed'));
    } else if (n.payload === 'permissions') {
      // Permissions change what each caller may list: reload, then tell clients to re-list.
      void perms.load().then(() => mcp.notify.toolsChanged()).catch(e => app.log.warn({ err: describeError(e) }, 'permission reload failed'));
    } else void manager.refresh().catch(() => {});
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${REGISTRY_CHANNEL}`);
  } catch (e) {
    retry(e);
  }
}

const mcpTarget = (body: any) => {
  if (body?.method !== 'tools/call' || typeof body?.params?.name !== 'string') return { tool: body?.method ?? null };
  const name: string = body.params.name;
  const i = name.indexOf(SEPARATOR);
  return i > 0 ? { server: name.slice(0, i), tool: name.slice(i + SEPARATOR.length) } : { tool: name };
};

app.route({
  method: ['GET', 'POST', 'DELETE'],
  url: '/mcp',
  handler: async (req, reply) => {
    if (!bootstrapped) return reply.code(503).send({ error: 'starting up' });
    const auth = await authenticate(db, req.headers.authorization, mcpTarget(req.body));
    if (!auth.ok) {
      if (!/missing|invalid/.test(auth.message)) rejected.inc({ reason: auth.message });   // the anonymous ones are counted in auth.ts
      app.log.info({ reason: auth.message, ip: req.ip }, 'rejected MCP request');
      return reply.code(auth.status).send({ error: auth.message });
    }
    // Rate limit per API key (token bucket, per replica). Counted, logged, not audited: the key is
    // valid, and a busy client would otherwise flood the audit log.
    const limit = mcpLimiter.take(auth.principal.apiKeyId ?? auth.principal.userId);
    if (!limit.ok) {
      rejected.inc({ reason: 'rate limited' });
      app.log.warn({ key: auth.principal.keyPrefix, user: auth.principal.email }, 'rate limited');
      return reply.code(429).header('retry-after', String(limit.retryAfterS))
        .send({ error: `rate limit: ${config.rateLimit.perMinute} requests per minute per key (burst ${config.rateLimit.burst}); retry in ${limit.retryAfterS} s` });
    }
    // ?mode=search asks for tool search mode (only honoured when the feature is on).
    const mode = (req.query as Record<string, string> | undefined)?.mode === 'search' ? 'search' : undefined;
    (req.raw as any).auth = { token: 'redacted', clientId: auth.principal.userId, scopes: [], extra: { principal: auth.principal, source: 'mcp', mode } };
    reply.raw.setHeader('x-gateway-replica', REPLICA);   // hijacked replies skip Fastify's headers
    reply.hijack();
    await mcpNode(req.raw, reply.raw, req.body);
  },
});

registerApi(app, { db, cipher, manager, core, perms, ssrf, pinning, features: config.features, chat: config.chat,
  chatLimiter: new RateLimiter(config.chatRateLimit.perMinute, config.chatRateLimit.burst) });

// Prometheus metrics on their own port: not behind the Ingress, and closed by NetworkPolicy except
// to the scrapers listed in the chart's values (and to kubectl port-forward / exec).
const metricsServer = http.createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/metrics') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
  res.end(renderMetrics(manager.snapshot().map(s => ({ prefix: s.prefix, status: s.status, tools: s.tools.length, latencyMs: s.latencyMs }))));
});
metricsServer.listen(config.metricsPort, '0.0.0.0');
await registerWeb(app);

app.get('/healthz', async () => ({ ok: true }));
app.get('/readyz', async (_req, reply) => {
  if (!bootstrapped) return reply.code(503).send({ ok: false, detail: 'bootstrap pending (database/schema not ready)' });
  try {
    await pool.query('select 1 from upstreams limit 1');
    return { ok: true };
  } catch (e) {
    return reply.code(503).send({ ok: false, detail: describeError(e) });
  }
});

const shutdown = async () => {
  app.log.info('shutting down');
  metricsServer.close();
  await app.close();
  await mcp.close();
  await manager.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
void bootstrapWithRetry().then(() => {
  manager.start();
  void listenForRegistryChanges();
  app.log.info('gateway ready');
});
