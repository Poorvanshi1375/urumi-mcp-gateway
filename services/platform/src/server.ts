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
import { createGatewayCore, createGatewayHandler, newRequestId } from './gateway/mcp.ts';
import { Permissions } from './services/permissions.ts';
import { Pinning } from './services/pins.ts';
import { SEPARATOR, UpstreamManager, describeError } from './gateway/upstream-manager.ts';
import { registerApi } from './api/routes.ts';
import { createGuardedFetch, managedHost, policyForUpstream, policyFromEnv } from './lib/ssrf.ts';
import { registerOAuth, resourceMetadataUrl } from './api/oauth.ts';
import { registerWeb } from './web.ts';
import { rejected, renderMetrics } from './lib/metrics.ts';
import { RateLimiter, SharedRateLimiter } from './lib/ratelimit.ts';
import { trustOneHop } from './lib/trust-proxy.ts';
import { sweepPendingAudit } from './services/audit.ts';

const config = loadConfig();
// trustProxy trusts exactly one hop (the socket peer, Traefik; hop 0): req.ip is the address Traefik saw and
// req.protocol its X-Forwarded-Proto. Anything a client writes into X-Forwarded-For further left
// is ignored, so a client cannot choose the address the sign-in and OAuth limits count against.
// (Traefik binds hostPort, infra/k3s/traefik-hostport.yaml, so that address is the real client's.)
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, disableRequestLogging: true, trustProxy: trustOneHop });
// Which replica answered, so load balancing across gateway pods is visible to clients and tests.
const REPLICA = os.hostname();
app.addHook('onRequest', async (_req, reply) => { reply.header('x-gateway-replica', REPLICA); });
await app.register(cookie);
const { pool, db } = createDb();
const cipher = createCredentialCipher(config.encryptionSecret);
// Shared by all replicas through Postgres (exact); per replica only if Postgres cannot answer.
let limiterWarned = 0;
const limiterError = (e: unknown) => { if (Date.now() - limiterWarned > 60_000) { limiterWarned = Date.now(); app.log.warn({ err: describeError(e) }, 'shared rate limit unavailable; using the per-replica limit'); } };
const authShield = new RateLimiter(config.authFailuresPerMinute, config.authFailuresPerMinute);
const mcpLimiter = new SharedRateLimiter(db, config.rateLimit.perMinute, config.rateLimit.burst, limiterError);

let mcp: ReturnType<typeof createGatewayHandler>;
const ssrf = policyFromEnv();
const pinning = new Pinning(db, config.features.toolPinning);
const oauthConfig = { enabled: config.features.oauth, publicUrl: config.publicUrl };
if (process.env.OAUTH === 'on' && !config.publicUrl) app.log.warn('OAUTH=on but PUBLIC_URL is empty: OAuth stays off');
app.log.info({ features: config.features }, 'feature flags');
if (ssrf.disabled) app.log.warn('SSRF guard is OFF (SSRF_GUARD=off): only for local development');
// Every upstream connection goes through the SSRF-guarded fetch. A managed upstream gets its own,
// whose policy also allows exactly its tenant's MCP Service (lib/ssrf.ts managedHost).
const guardedFetch = createGuardedFetch(ssrf, { maxResponseBytes: config.maxResponseBytes });
const managedFetches = new Map<string, typeof fetch>();
const fetchFor = (row: { prefix: string; managedBy: string | null }) => {
  const host = managedHost(row);
  if (!host) return guardedFetch;
  let f = managedFetches.get(host);
  if (!f) managedFetches.set(host, f = createGuardedFetch(policyForUpstream(ssrf, row), { maxResponseBytes: config.maxResponseBytes }));
  return f;
};
const manager = new UpstreamManager(db, cipher, { ...config, fetch: guardedFetch, fetchFor, validateArguments: config.features.validateArguments, pinning: pinning.enabled ? pinning : undefined,
  releaseManaged: config.bootstrap.upstreams.filter(u => u.releaseManaged).map(u => ({ prefix: u.prefix, url: u.url })) }, () => mcp?.notify.toolsChanged(), app.log);
const perms = new Permissions(db, config.memberDefault);
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
    // Load shield (idea R): an address that keeps failing authentication is answered 429 before
    // any key lookup, so a flood of bad keys costs no database queries. Only failures count; it
    // is per replica and in memory, a shield rather than an exact limit. req.ip is the real client
    // address (idea Q), so one client cannot block another.
    const shield = authShield.peek(req.ip);
    if (!shield.ok) {
      rejected.inc({ reason: 'auth failures throttled' });
      return reply.code(429).header('retry-after', String(shield.retryAfterS))
        .send({ error: `too many failed authentications from this address; retry in ${shield.retryAfterS} s` });
    }
    const auth = await authenticate(db, req.headers.authorization, mcpTarget(req.body), { oauth: oauthConfig.enabled });
    if (!auth.ok) authShield.take(req.ip);
    if (!auth.ok) {
      if (!/missing|invalid/.test(auth.message)) rejected.inc({ reason: auth.message });   // the anonymous ones are counted in auth.ts
      app.log.info({ reason: auth.message, ip: req.ip }, 'rejected MCP request');
      // Tell the client how to authenticate (RFC 6750). With OAuth on, also where to get a token
      // (RFC 9728): Claude Code and other MCP clients then start the browser sign-in by themselves.
      const challenge = oauthConfig.enabled
        ? `Bearer resource_metadata="${resourceMetadataUrl(oauthConfig)}"${req.headers.authorization ? ', error="invalid_token"' : ''}`
        : 'Bearer realm="urumi-gateway"';
      return reply.code(auth.status).header('www-authenticate', challenge).send({ error: auth.message });
    }
    // Rate limit per API key (token bucket shared by the replicas). Counted, logged, not audited: the
    // key is valid, and a busy client would otherwise flood the audit log.
    // Per API key; OAuth clients share their user's bucket.
    const limit = await mcpLimiter.take(auth.principal.apiKeyId ? `mcp:key:${auth.principal.apiKeyId}` : `mcp:user:${auth.principal.userId}`);
    if (!limit.ok) {
      rejected.inc({ reason: 'rate limited' });
      app.log.warn({ key: auth.principal.keyPrefix, user: auth.principal.email }, 'rate limited');
      return reply.code(429).header('retry-after', String(limit.retryAfterS))
        .send({ error: `rate limit: ${config.rateLimit.perMinute} requests per minute per key (burst ${config.rateLimit.burst}); retry in ${limit.retryAfterS} s` });
    }
    // ?mode=search asks for tool search mode (only honoured when the feature is on).
    const mode = (req.query as Record<string, string> | undefined)?.mode === 'search' ? 'search' : undefined;
    // One id per request, returned to the client and carried into the audit and upstream logs.
    const requestId = newRequestId();
    (req.raw as any).auth = { token: 'redacted', clientId: auth.principal.userId, scopes: [], extra: { principal: auth.principal, source: 'mcp', mode, requestId } };
    reply.raw.setHeader('x-gateway-replica', REPLICA);   // hijacked replies skip Fastify's headers
    reply.raw.setHeader('x-request-id', requestId);
    reply.hijack();
    await mcpNode(req.raw, reply.raw, req.body);
  },
});

registerOAuth(app, db, oauthConfig);
registerApi(app, { db, cipher, manager, core, perms, ssrf, pinning, features: config.features, hosted: config.hosted, oauth: oauthConfig, chat: config.chat,
  chatLimiter: new SharedRateLimiter(db, config.chatRateLimit.perMinute, config.chatRateLimit.burst, limiterError) });

// Prometheus metrics on their own port: not behind the Ingress, and closed by NetworkPolicy except
// to the scrapers listed in the chart's values (and to kubectl port-forward / exec).
const metricsServer = http.createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/metrics') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
  res.end(renderMetrics(manager.snapshot().map(s => ({ prefix: s.prefix, status: s.status, tools: s.tools.length, latencyMs: s.latencyMs, inFlight: s.inFlight }))));
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
  // Rows a call never completed (update failed, or a replica stopped mid-call) become "unknown".
  setInterval(() => void sweepPendingAudit(db, config.callTimeoutMs + 30_000)
    .then(rows => { if (rows.length) app.log.warn({ rows: rows.length }, 'audit rows left pending marked unknown'); })
    .catch(() => {}), 60_000).unref();
  void listenForRegistryChanges();
  app.log.info('gateway ready');
});
