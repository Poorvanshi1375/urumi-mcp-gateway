// Dashboard API (JSON under /api). Browsers authenticate with a session cookie; scripts may use an
// API key (Bearer). Admin-only routes return 403 to members (T1). Credentials are write-only (G5).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { verifyPassword } from '../lib/crypto.ts';
import { authenticate } from '../gateway/auth.ts';
import type { UpstreamManager } from '../gateway/upstream-manager.ts';
import { CALL_TOOL, newRequestId, SEARCH_TOOL, searchModeTools, unwrapCall, type GatewayCore } from '../gateway/mcp.ts';
import type { Principal } from '../gateway/auth.ts';
import { ALL_TOOLS, asksInChat, listRules, setConfirmRule, setMemberRule, type Permissions } from '../services/permissions.ts';
import { createHosted, deleteHosted, findHosted, HostedError, listHosted, publicHosted, retryHosted, SIZES, tenantNameConflict, type HostedLimits } from '../services/hosted.ts';
import { COUNTRIES, CURRENCIES, createStore, deleteStore, findStore, listStores, publicStore, retryStore, TIMEZONES, type StoreLimits } from '../services/stores.ts';
import { createProposal, decide, declineWaiting, listWaiting, ProposalError, publicProposal, setProposalAudit, summarize } from '../services/proposals.ts';
import { runAgent, summarizeConfirmed, type AgentEvent, type ChatConfig, type ToolExec } from '../chat/agent.ts';
import type { CredentialCipher } from '../lib/crypto.ts';
import { listAudit } from '../services/audit.ts';
import { csvRow } from '../lib/csv.ts';
import { clearEmail, isThrottled, noteFailure } from '../services/login-throttle.ts';
import { listActivity, recordActivity, type Action } from '../services/activity.ts';
import { counters } from '../lib/metrics.ts';
import type { SharedRateLimiter } from '../lib/ratelimit.ts';
import { assertUrlAllowed, SsrfError, type SsrfPolicy } from '../lib/ssrf.ts';
import { definitionOf, stable, type Pinning } from '../services/pins.ts';
import { acceptInvite, createInvite, deleteInvite, findOpenInvite, listInvites } from '../services/invites.ts';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/keys.ts';
import { issueCode, listGrants, revokeGrantOf, revokeUserGrants } from '../services/oauth.ts';
import { checkAuthorizeRequest, redirectBack, type OAuthConfig } from './oauth.ts';
import { createSession, deleteOtherSessions, deleteSession, deleteUserSessions, SESSION_TTL_MS, sessionUser } from '../services/sessions.ts';
import { createUpstream, deleteUpstream, findUpstream, listUpstreams, ManagedRowError, PREFIX_RE, publicUpstream, updateUpstream } from '../services/upstreams.ts';
import { findUserByEmail, findUserById, LastAdminError, listUsers, publicUser, setPassword, updateUser, type User } from '../services/users.ts';

export const SESSION_COOKIE = 'urumi_session';

// Validation errors from the service layer (e.g. a URL with a query string) are the caller's fault.
const badInput = (e: unknown): never => {
  if (e instanceof Error && /^(url|prefix|authHeaderName)\b/.test(e.message)) throw new HttpError(400, e.message);
  throw e;
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Deps = { db: Db; cipher: CredentialCipher; manager: UpstreamManager; core: GatewayCore; perms: Permissions; ssrf: SsrfPolicy; pinning: Pinning;
  features: { toolPinning: boolean; toolSearch: boolean; oauth: boolean; provisioner?: boolean }; hosted: HostedLimits; stores: StoreLimits & { enabled: boolean }; oauth: OAuthConfig; chat?: ChatConfig; chatLimiter: SharedRateLimiter };
type Me = { user: User; via: 'session' | 'key' };

// Login throttling: services/login-throttle.ts (shared by all replicas through Postgres).

// A dummy hash so a login for an unknown email costs the same as a wrong password.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(10, 'at least 10 characters').max(200);
const role = z.enum(['admin', 'member']);
const serverFields = z.object({
  prefix: z.string().regex(PREFIX_RE, '2-12 lowercase letters or digits'),
  name: z.string().trim().min(1).max(80),
  url: z.string().url(),
  authType: z.enum(['none', 'bearer', 'header']),
  authHeaderName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullish(),
  credential: z.string().max(4000).nullish(),   // write-only
  enabled: z.boolean().optional(),
  trustAnnotations: z.boolean().optional(),   // M: believe this server's read-only hints
});
const serverCreate = serverFields.extend({ authType: serverFields.shape.authType.default('none') });
// No defaults here: zod applies .default() to omitted fields even after .partial(), which would
// silently reset authType (and drop the stored credential) on every edit.
const serverPatch = serverFields.partial();

// The chat agent acts as the signed-in user; it has no API key of its own.
const principalOf = (user: User): Principal => ({ userId: user.id, email: user.email, role: user.role as Principal['role'], apiKeyId: null, keyPrefix: null });

export function registerApi(app: FastifyInstance, { db, cipher, manager, core, perms, ssrf, pinning, features, hosted, stores, oauth, chat, chatLimiter }: Deps) {
  // Refuse URLs the gateway must not connect to, with the reason (the same check runs again on
  // every connection, so this is for a clear error, not the only line of defence).
  const checkUrl = (url: string) => assertUrlAllowed(url, ssrf).catch(e => { throw e instanceof SsrfError ? new HttpError(400, e.message) : e; });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid input', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof LastAdminError || err instanceof ManagedRowError) return reply.code(409).send({ error: err.message });
    if (err instanceof HostedError) return reply.code(err.status).send({ error: err.message });
    if ((err as any).code === '23505') return reply.code(409).send({ error: 'already exists' });   // unique violation
    const status = (err as any).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, 'unhandled API error');
    return reply.code(500).send({ error: 'internal error' });
  });

  // CSRF: state-changing browser requests must be JSON (a cross-site form cannot send that without
  // a CORS preflight, which we never allow) and, when the browser sends Origin, same-origin.
  app.addHook('onRequest', async req => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    // "Origin: null" (sandboxed frames, some redirects) or anything unparsable counts as cross-origin.
    if (origin && URL.parse(origin)?.host !== req.headers.host) throw new HttpError(403, 'cross-origin request refused');
    if (req.method !== 'DELETE' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON body required');
  });

  async function me(req: FastifyRequest): Promise<Me> {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (raw) {
      const user = await sessionUser(db, raw);
      if (user && !user.disabledAt) return { user, via: 'session' };
    }
    if (req.headers.authorization) {
      const r = await authenticate(db, req.headers.authorization, { tool: `${req.method} ${req.routeOptions.url}` });
      if (r.ok) return { user: (await findUserById(db, r.principal.userId))!, via: 'key' };
    }
    throw new HttpError(401, 'not logged in');
  }
  async function admin(req: FastifyRequest): Promise<Me> {
    const m = await me(req);
    if (m.user.role !== 'admin') throw new HttpError(403, 'admin only');
    return m;
  }
  const setSessionCookie = (req: FastifyRequest, reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge: SESSION_TTL_MS / 1000 });
  const refreshRegistry = () => Promise.race([manager.refresh(), new Promise(r => setTimeout(r, 10_000))]);
  // Activity rows must never break the action they describe.
  const activity = (req: FastifyRequest, actor: User | null, action: Action, target: string | null, detail?: Record<string, unknown>) =>
    recordActivity(db, actor && { id: actor.id, email: actor.email }, action, target, detail, req.ip)
      .catch(e => req.log.error({ err: String(e), action }, 'activity write failed'));

  // Chat answers stream as server-sent events, one JSON event per message.
  function openStream(reply: FastifyReply) {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const ac = new AbortController();
    res.on('close', () => ac.abort());   // the browser went away: stop calling the model and tools
    return {
      emit: (e: AgentEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); },
      signal: ac.signal,
      end: () => res.end(),
    };
  }
  // A chat tool call, as the signed-in user, through the same core as /mcp.
  const chatToolSearchAbove = Number(process.env.CHAT_TOOL_SEARCH_ABOVE ?? 40);
  const execAs = (principal: Principal, requestId: string, onAudit?: (auditId: number) => Promise<unknown>): ToolExec => async (name, args) => {
    const r = await core.callAsUser(principal, 'chat', name, args, { requestId });
    if (r.auditId !== undefined) await onAudit?.(r.auditId);
    const text = (r.result.content ?? []).map(c => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
    return { text, isError: Boolean(r.result.isError), outcome: r.outcome, durationMs: r.durationMs };
  };

  // ---- auth
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email, password: z.string().max(200) }).parse(req.body);
    if (await isThrottled(db, body.email, req.ip)) {
      throw new HttpError(429, 'too many failed sign-in attempts; try again in 15 minutes');
    }
    const user = await findUserByEmail(db, body.email);
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || user.disabledAt) {
      await noteFailure(db, body.email, req.ip);
      // Only attributable failures: an unknown email is just counted by the throttle.
      if (user) await activity(req, null, 'login_failed', user.email, { reason: user.disabledAt ? 'user disabled' : 'wrong password' });
      throw new HttpError(401, 'invalid email or password');
    }
    await clearEmail(db, body.email);
    setSessionCookie(req, reply, await createSession(db, user.id));
    await activity(req, user, 'login', user.email);
    return { user: publicUser(user) };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (raw) await deleteSession(db, raw);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async req => ({ user: publicUser((await me(req)).user) }));
  app.post('/api/me/password', async req => {
    const { user } = await me(req);
    const body = z.object({ currentPassword: z.string().max(200), newPassword: password }).parse(req.body);
    if (!(await verifyPassword(body.currentPassword, user.passwordHash ?? DUMMY_HASH))) throw new HttpError(403, 'current password is wrong');
    await setPassword(db, user.id, body.newPassword);
    // Sign out every other device; the session making this request stays valid.
    await deleteOtherSessions(db, user.id, req.cookies?.[SESSION_COOKIE]);
    await activity(req, user, 'password_changed', user.email, { otherSessionsEnded: true });
    return { ok: true };
  });

  // ---- invites (T5)
  app.get('/api/invites', async req => { await admin(req); return { invites: await listInvites(db) }; });
  app.post('/api/invites', async req => {
    const { user } = await admin(req);
    const body = z.object({ email, role: role.default('member') }).parse(req.body);
    if (await findUserByEmail(db, body.email)) throw new HttpError(409, 'a user with this email already exists');
    const { token, invite } = await createInvite(db, { ...body, invitedBy: user.id });
    await activity(req, user, 'invite_sent', body.email, { role: body.role });
    return { invite, token, acceptPath: `/invite/${token}`, note: 'shown once' };
  });
  app.delete('/api/invites/:id', async req => {
    const { user } = await admin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inv = (await listInvites(db)).find(i => i.id === id);
    if (!(await deleteInvite(db, id))) throw new HttpError(404, 'no open invite with this id');
    await activity(req, user, 'invite_revoked', inv?.email ?? id);
    return { ok: true };
  });
  app.get('/api/invites/:token', async req => {
    const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.params);
    const inv = await findOpenInvite(db, token);
    if (!inv) throw new HttpError(404, 'invite not found, used or expired');
    return { email: inv.email, role: inv.role, expiresAt: inv.expiresAt };
  });
  app.post('/api/invites/accept', async (req, reply) => {
    const body = z.object({ token: z.string().min(10).max(100), name: z.string().trim().max(80).optional(), password }).parse(req.body);
    const user = await acceptInvite(db, body.token, body);
    if (!user) throw new HttpError(404, 'invite not found, used or expired');
    await activity(req, user, 'invite_accepted', user.email, { role: user.role });
    setSessionCookie(req, reply, await createSession(db, user.id));
    return { user: publicUser(user) };
  });

  // ---- users (T1)
  app.get('/api/users', async req => { await admin(req); return { users: (await listUsers(db)).map(publicUser) }; });
  app.patch('/api/users/:id', async req => {
    const { user: actor } = await admin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ role: role.optional(), disabled: z.boolean().optional(), name: z.string().trim().max(80).optional() }).parse(req.body);
    const before = await findUserById(db, id);
    const user = await updateUser(db, id, body);
    if (!user || !before) throw new HttpError(404, 'no such user');
    if (body.role && body.role !== before.role) await activity(req, actor, 'role_changed', user.email, { from: before.role, to: body.role });
    if (body.disabled !== undefined && body.disabled !== Boolean(before.disabledAt)) await activity(req, actor, body.disabled ? 'user_disabled' : 'user_enabled', user.email);
    if (body.name !== undefined && body.name !== before.name) await activity(req, actor, 'user_renamed', user.email, { from: before.name, to: body.name });
    if (body.disabled) { await deleteUserSessions(db, id); await revokeUserGrants(db, id); }   // signed out everywhere, apps disconnected
    return { user: publicUser(user) };
  });

  // ---- API keys (T2, T6): everyone manages their own; admins can see and revoke all.
  app.get('/api/keys', async req => {
    const { user } = await me(req);
    const all = (req.query as any)?.all === '1' && user.role === 'admin';
    return { keys: await listApiKeys(db, all ? undefined : user.id) };
  });
  app.post('/api/keys', async req => {
    const { user } = await me(req);
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const { key, row } = await createApiKey(db, user.id, name);
    await activity(req, user, 'key_created', user.email, { prefix: row.prefix, name: row.name });
    return { key, id: row.id, prefix: row.prefix, name: row.name, note: 'shown once' };
  });
  app.delete('/api/keys/:id', async req => {
    const { user } = await me(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await revokeApiKey(db, id, user.role === 'admin' ? undefined : user.id);
    if (!row) throw new HttpError(404, 'no active key with this id');
    const owner = row.userId === user.id ? user : await findUserById(db, row.userId);
    await activity(req, user, 'key_revoked', owner?.email ?? row.userId, { prefix: row.prefix, name: row.name });
    return { ok: true, revokedAt: row.revokedAt };
  });

  // ---- OAuth consent and connected apps (stand-out 3; endpoints in api/oauth.ts). Approving needs
  // a dashboard session: a browser sign-in, not an API key.
  const oauthOn = () => { if (!oauth.enabled) throw new HttpError(404, 'OAuth is not enabled (platform.features.oauth)'); };
  const sessionUserFor = async (req: FastifyRequest) => {
    const m = await me(req);
    if (m.via !== 'session') throw new HttpError(403, 'approving an app needs a dashboard sign-in');
    return m.user;
  };
  const authorizeParams = z.record(z.string(), z.string().max(2000));
  app.get('/api/oauth/request', async req => {
    oauthOn();
    const user = await sessionUserFor(req);
    const r = await checkAuthorizeRequest(db, oauth, authorizeParams.parse(req.query));
    if ('fatal' in r) throw new HttpError(400, r.fatal);
    if ('error' in r) return { redirect: redirectBack(oauth, r.redirectUri, { error: r.error, error_description: r.description, state: r.state }) };
    return { client: r.ok.client.name, redirectHost: new URL(r.ok.redirectUri).host, user: publicUser(user), resource: `${oauth.publicUrl}/mcp` };
  });
  app.post('/api/oauth/approve', async req => {
    oauthOn();
    const user = await sessionUserFor(req);
    const r = await checkAuthorizeRequest(db, oauth, authorizeParams.parse(req.body));
    if ('fatal' in r) throw new HttpError(400, r.fatal);
    if ('error' in r) return { redirect: redirectBack(oauth, r.redirectUri, { error: r.error, error_description: r.description, state: r.state }) };
    const code = await issueCode(db, { clientRowId: r.ok.client.id, userId: user.id, redirectUri: r.ok.redirectUri, codeChallenge: r.ok.codeChallenge });
    await activity(req, user, 'oauth_approved', user.email, { client: r.ok.client.name });
    return { redirect: redirectBack(oauth, r.ok.redirectUri, { code, state: r.ok.state }) };
  });
  app.post('/api/oauth/deny', async req => {
    oauthOn();
    await sessionUserFor(req);
    const r = await checkAuthorizeRequest(db, oauth, authorizeParams.parse(req.body));
    if ('fatal' in r) throw new HttpError(400, r.fatal);
    const back = 'ok' in r ? r.ok : r;
    return { redirect: redirectBack(oauth, back.redirectUri, { error: 'access_denied', error_description: 'the user declined', state: back.state }) };
  });
  app.get('/api/oauth/grants', async req => {
    oauthOn();
    const { user } = await me(req);
    const all = (req.query as any)?.all === '1' && user.role === 'admin';
    return { grants: await listGrants(db, all ? undefined : user.id) };
  });
  app.delete('/api/oauth/grants/:id', async req => {
    oauthOn();
    const { user } = await me(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await revokeGrantOf(db, id, user.role === 'admin' ? undefined : user.id);
    if (!row) throw new HttpError(404, 'no active connected app with this id');
    const owner = row.userId === user.id ? user : await findUserById(db, row.userId);
    await activity(req, user, 'oauth_revoked', owner?.email ?? row.userId, { grant: row.id });
    return { ok: true };
  });

  // ---- MCP servers (G1, G7). Everyone may view status and tools; only admins change them.
  // Members see each server's status and tools but not its URL: only admins need to know where
  // an upstream lives.
  async function serversView(isAdmin = true) {
    const live = new Map(manager.snapshot().map(s => [s.prefix, s]));
    return (await listUpstreams(db)).map(u => {
      const s = live.get(u.prefix);
      return { ...publicUpstream(u), ...(isAdmin ? {} : { url: null }), status: u.enabled ? (s?.status ?? 'unknown') : 'disabled', error: s?.error ?? null,
        checkedAt: s?.checkedAt ?? null, latencyMs: s?.latencyMs ?? null, pinned: s?.pinned ?? false, annotationsTrusted: s?.annotationsTrusted ?? u.trustAnnotations, lastOutage: s?.lastOutage ?? null, outages: s?.outages ?? 0,
        tools: (s?.tools ?? []).map(t => ({ ...t, memberAllowed: perms.allows('member', u.prefix, t.name, manager.readOnly(u.prefix, t)),
          chatConfirm: perms.confirmMode(u.prefix, t.name), asksInChat: asksInChat(perms.confirmMode(u.prefix, t.name), manager.readOnly(u.prefix, t)),
          // For a tool waiting for re-approval, admins get the approved version to diff against.
          ...(t.pending && isAdmin ? { approved: pinning.approved(u.id, t.name) } : {}) })) };
    });
  }
  app.get('/api/servers', async req => { const { user } = await me(req); return { servers: await serversView(user.role === 'admin') }; });
  app.post('/api/servers', async req => {
    const { user } = await admin(req);
    const body = serverCreate.parse(req.body);
    if (body.authType !== 'none' && !body.credential) throw new HttpError(400, 'credential is required for bearer/header auth');
    const taken = await tenantNameConflict(db, body.prefix);
    if (taken) throw new HttpError(409, `prefix "${body.prefix}" is already used by ${taken}`);
    await checkUrl(body.url);
    const row = await createUpstream(db, cipher, body).catch(badInput);
    await activity(req, user, 'server_added', row.prefix, { name: row.name, url: row.url, authType: row.authType, credential: row.credentialEnc ? 'set' : 'none', enabled: row.enabled });
    await refreshRegistry();
    return { server: (await serversView()).find(s => s.id === row.id) };
  });
  app.patch('/api/servers/:prefix', async req => {
    const { user } = await admin(req);
    const { prefix } = z.object({ prefix: z.string() }).parse(req.params);
    const body = serverPatch.parse(req.body);
    const current = await findUpstream(db, prefix);
    if (!current) throw new HttpError(404, 'no such server');
    const authType = body.authType ?? current.authType;
    if (authType !== 'none' && body.authType && body.authType !== current.authType && !body.credential) throw new HttpError(400, 'a new credential is required when changing the auth type');
    if (body.url !== undefined && body.url !== current.url) await checkUrl(body.url);
    const row = await updateUpstream(db, cipher, prefix, body).catch(badInput);
    // What changed, field by field; the credential only as "changed" or "cleared".
    const changes: Record<string, unknown> = {};
    for (const k of ['prefix', 'name', 'url', 'authType', 'authHeaderName', 'trustAnnotations'] as const) {
      if (body[k] !== undefined && body[k] !== current[k]) changes[k] = { from: current[k], to: body[k] };
    }
    if (body.credential !== undefined) changes.credential = body.credential ? 'changed' : 'cleared';
    if (Object.keys(changes).length) await activity(req, user, 'server_edited', row!.prefix, changes);
    if (body.enabled !== undefined && body.enabled !== current.enabled) await activity(req, user, body.enabled ? 'server_enabled' : 'server_disabled', row!.prefix);
    await refreshRegistry();
    return { server: (await serversView()).find(s => s.id === row!.id) };
  });
  // Tool permissions (stand-out item 2): whether members may use one tool, or (tool "*") the whole
  // server. Admins always may. Takes effect on every replica at once (NOTIFY) and makes connected
  // clients re-list their tools.
  app.get('/api/permissions', async req => { await admin(req); return { rules: await listRules(db) }; });

  // Hosted MCP servers (stand-out 5). Admins only; 404 while the provisioner is off. The gateway
  // writes the desired state; the provisioner, the only component with a Kubernetes token, runs it.
  const hostedOn = () => { if (!features.provisioner) throw new HttpError(404, 'hosted servers are off (provisioner.enabled)'); };
  const envMap = z.record(z.string(), z.string().max(4000)).optional();
  app.get('/api/hosted', async req => {
    hostedOn(); await admin(req);
    const live = new Map(manager.snapshot().map(s => [s.prefix, s]));
    return { servers: (await listHosted(db)).map(h => ({ ...publicHosted(h, cipher), server: live.has(h.prefix) ? { status: live.get(h.prefix)!.status, tools: live.get(h.prefix)!.tools.length } : null })),
      allowedImages: hosted.allowedImages, maxServers: hosted.maxServers, sizes: SIZES };
  });
  app.post('/api/hosted', async req => {
    hostedOn();
    const { user } = await admin(req);
    const body = z.object({
      prefix: z.string().trim(), name: z.string().trim().min(1).max(80), image: z.string().trim().min(1).max(255),
      port: z.number().int().min(1024).max(65535).optional(), path: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,200}$/, 'must start with /').optional(),
      env: envMap, secretEnv: envMap, size: z.enum(SIZES).optional(), needsInternet: z.boolean().optional(),
      transport: z.enum(['http', 'stdio']).optional(), command: z.array(z.string().min(1).max(1000)).max(32).optional(),
    }).parse(req.body);
    const row = await createHosted(db, cipher, body, user.id, hosted);
    await activity(req, user, 'hosted_requested', row.prefix, { image: row.image, size: row.size, needsInternet: row.needsInternet, secretEnv: Object.keys(body.secretEnv ?? {}) });
    return { server: publicHosted(row, cipher) };
  });
  app.post('/api/hosted/:id/retry', async req => {
    hostedOn();
    const { user } = await admin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await retryHosted(db, id, hosted.timeoutMs))) throw new HttpError(409, 'only a failed hosted server can be retried');
    const row = await findHosted(db, id);
    await activity(req, user, 'hosted_requested', row?.prefix ?? id, { retry: true });
    return { server: row && publicHosted(row, cipher) };
  });
  app.delete('/api/hosted/:id', async req => {
    hostedOn();
    const { user } = await admin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await findHosted(db, id);
    if (!row) throw new HttpError(404, 'no such hosted server');
    if (!(await deleteHosted(db, id))) throw new HttpError(409, 'already being deleted');
    await activity(req, user, 'hosted_delete_requested', row.prefix);
    return { ok: true };
  });

  // Bonus stores (multi-store). Admins only; 404 unless the provisioner and stores are on.
  const storesOn = () => { if (!features.provisioner || !stores.enabled) throw new HttpError(404, 'stores are off (provisioner.enabled, provisioner.stores.enabled)'); };
  app.get('/api/stores', async req => {
    storesOn(); await admin(req);
    const live = new Map(manager.snapshot().map(s => [s.prefix, s]));
    return { stores: (await listStores(db)).map(s => ({ ...publicStore(s, stores), server: live.has(s.slug) ? { status: live.get(s.slug)!.status, tools: live.get(s.slug)!.tools.length } : null })),
      max: stores.max, baseHost: stores.baseHost, currencies: CURRENCIES, countries: COUNTRIES, timezones: TIMEZONES };
  });
  app.post('/api/stores', async req => {
    storesOn();
    const { user } = await admin(req);
    const body = z.object({ slug: z.string().trim(), title: z.string().trim().min(1).max(80), currency: z.string().optional(), country: z.string().optional(),
      timezone: z.string().optional(), adminEmail: email.optional() }).parse(req.body);
    const row = await createStore(db, body, { id: user.id, email: user.email }, stores);
    await activity(req, user, 'store_requested', row.slug, { title: row.title, host: row.host, currency: row.currency });
    return { store: publicStore(row, stores) };
  });
  app.post('/api/stores/:id/retry', async req => {
    storesOn();
    const { user } = await admin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await retryStore(db, id, stores.timeoutMs))) throw new HttpError(409, 'only a failed store can be retried');
    const row = await findStore(db, id);
    await activity(req, user, 'store_requested', row?.slug ?? id, { retry: true });
    return { store: row && publicStore(row, stores) };
  });
  // Deleting a store destroys its data: the request must name it (?confirm=<slug>).
  app.delete('/api/stores/:id', async req => {
    storesOn();
    const { user } = await admin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await findStore(db, id);
    if (!row) throw new HttpError(404, 'no such store');
    if ((req.query as Record<string, string> | undefined)?.confirm !== row.slug) throw new HttpError(400, `type the store's name to confirm: ?confirm=${row.slug}`);
    if (!(await deleteStore(db, id))) throw new HttpError(409, 'already being deleted');
    await activity(req, user, 'store_delete_requested', row.slug);
    return { ok: true };
  });

  app.get('/api/features', async req => { await me(req); return { ...features, stores: Boolean(features.provisioner && stores.enabled), memberDefault: perms.memberDefault }; });
  // Tool pinning: approve the current definition of a tool that changed (or appeared) since the
  // last approval. It becomes visible to clients again on every replica.
  app.post('/api/servers/:prefix/tools/:tool/approve', async req => {
    const { user } = await admin(req);
    if (!pinning.enabled) throw new HttpError(409, 'tool pinning is not enabled (platform.features.toolPinning)');
    const { prefix, tool } = z.object({ prefix: z.string(), tool: z.string().min(1).max(200) }).parse(req.params);
    const current = manager.currentTool(prefix, tool);
    if (!current) throw new HttpError(404, `server ${prefix} has no tool ${tool} right now`);
    const before = pinning.approved(current.upstream.id, tool);
    await pinning.approve(current.upstream.id, current.tool, user.id);
    manager.reapplyPins();
    await activity(req, user, 'tool_approved', prefix, { tool, changed: before ? Object.keys(definitionOf(current.tool)).filter(k => stable((definitionOf(current.tool) as any)[k]) !== stable((before as any)[k])) : 'new tool' });
    return { server: (await serversView()).find(s => s.prefix === prefix) };
  });
  app.put('/api/servers/:prefix/permissions', async req => {
    const { user } = await admin(req);
    const { prefix } = z.object({ prefix: z.string() }).parse(req.params);
    const body = z.object({ tool: z.string().min(1).max(200), memberAllowed: z.boolean() }).parse(req.body);
    const server = manager.snapshot().find(s => s.prefix === prefix);
    if (!server) throw new HttpError(404, 'no such server');
    if (body.tool !== ALL_TOOLS && !server.tools.some(t => t.name === body.tool)) throw new HttpError(404, `server ${prefix} has no tool ${body.tool}`);
    await setMemberRule(db, prefix, body.tool, body.memberAllowed, user.id);
    await activity(req, user, 'permission_changed', prefix, { tool: body.tool, memberAllowed: body.memberAllowed });
    await perms.load();
    return { server: (await serversView()).find(s => s.prefix === prefix) };
  });
  // When chat asks before running a tool (C): auto (from a trusted read-only hint), always, never.
  app.put('/api/servers/:prefix/confirm', async req => {
    const { user } = await admin(req);
    const { prefix } = z.object({ prefix: z.string() }).parse(req.params);
    const body = z.object({ tool: z.string().min(1).max(200), mode: z.enum(['auto', 'always', 'never']) }).parse(req.body);
    const server = manager.snapshot().find(s => s.prefix === prefix);
    if (!server) throw new HttpError(404, 'no such server');
    if (body.tool !== ALL_TOOLS && !server.tools.some(t => t.name === body.tool)) throw new HttpError(404, `server ${prefix} has no tool ${body.tool}`);
    await setConfirmRule(db, prefix, body.tool, body.mode, user.id);
    await activity(req, user, 'permission_changed', prefix, { tool: body.tool, chatConfirm: body.mode });
    await perms.load();
    return { server: (await serversView()).find(s => s.prefix === prefix) };
  });
  app.delete('/api/servers/:prefix', async req => {
    const { user } = await admin(req);
    const { prefix } = z.object({ prefix: z.string() }).parse(req.params);
    if (!(await deleteUpstream(db, prefix))) throw new HttpError(404, 'no such server');
    await activity(req, user, 'server_removed', prefix);
    await refreshRegistry();
    return { ok: true };
  });

  // ---- audit (T3, D9): admins see everyone; members see their own calls.
  const auditFilter = z.object({
    before: z.coerce.number().int().optional(),
    userId: z.string().uuid().optional(),
    server: z.string().max(12).optional(),
    outcome: z.enum(['ok', 'tool_error', 'timeout', 'upstream_unreachable', 'rejected', 'denied', 'busy', 'pending', 'unknown']).optional(),
    requestId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  });
  app.get('/api/audit', async req => {
    const { user } = await me(req);
    const q = auditFilter.extend({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const userId = user.role === 'admin' ? q.userId : user.id;
    return { events: await listAudit(db, { ...q, userId }) };
  });
  // The same rows as a spreadsheet-safe CSV (lib/csv.ts), newest first, at most 10,000. Same
  // scoping as above: members get only their own rows. A GET, so the CSRF rule does not apply.
  app.get('/api/audit/export.csv', async (req, reply) => {
    const { user } = await me(req);
    const q = auditFilter.parse(req.query);
    const userId = user.role === 'admin' ? q.userId : user.id;
    const rows = await listAudit(db, { ...q, userId, limit: 10_000, max: 10_000 });
    const head = csvRow(['at', 'user', 'key_prefix', 'source', 'server', 'tool', 'outcome', 'duration_ms', 'request_id', 'args_sha256', 'error']);
    const body = rows.map(r => csvRow([r.at, r.user, r.keyPrefix, r.source, r.server, r.tool, r.outcome, r.durationMs, r.requestId, r.argsSha256, r.error])).join('');
    return reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="urumi-audit-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header('cache-control', 'no-store').send(head + body);
  });

  // Activity (work item 6): admins see everything; members see what they did and what was done to
  // them (for example an admin revoking their key).
  app.get('/api/activity', async req => {
    const { user } = await me(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional(), actorId: z.string().uuid().optional() }).parse(req.query);
    return { events: await listActivity(db, user.role === 'admin' ? q : { ...q, actorId: user.id, about: user.email }) };
  });

  // Summary numbers for the dashboard (last 24 h). Admins get workspace totals and per-user
  // activity; members get their own numbers only.
  app.get('/api/overview', async req => {
    const { user } = await me(req);
    const isAdmin = user.role === 'admin';
    const scope = isAdmin ? sql`true` : sql`a.user_id = ${user.id}`;
    const calls = (await db.execute(sql`
      select count(*)::int as calls,
             count(*) filter (where a.outcome not in ('ok', 'pending'))::int as errors,
             count(*) filter (where a.outcome in ('rejected', 'denied'))::int as rejected,
             coalesce(round(avg(a.duration_ms) filter (where a.outcome = 'ok'))::int, 0) as avg_ms,
             coalesce(round(percentile_cont(0.95) within group (order by a.duration_ms) filter (where a.outcome = 'ok'))::int, 0) as p95_ms
      from audit_events a where a.created_at > now() - interval '24 hours' and ${scope}`)).rows[0];
    const perServer = (await db.execute(sql`
      select a.server_prefix as server, count(*)::int as calls, count(*) filter (where a.outcome not in ('ok', 'pending'))::int as errors,
             -- Latency of successful calls per server (stand-out 8 in the dashboard, not only Prometheus).
             round(percentile_cont(0.5) within group (order by a.duration_ms) filter (where a.outcome = 'ok'))::int as p50_ms,
             round(percentile_cont(0.95) within group (order by a.duration_ms) filter (where a.outcome = 'ok'))::int as p95_ms
      from audit_events a where a.created_at > now() - interval '24 hours' and a.server_prefix is not null and ${scope}
      group by a.server_prefix`)).rows;
    if (!isAdmin) return { scope: 'me', calls, perServer };
    const people = (await db.execute(sql`
      select count(*) filter (where disabled_at is null)::int as active,
             count(*) filter (where disabled_at is null and role = 'admin')::int as admins,
             count(*) filter (where disabled_at is not null)::int as disabled,
             (select count(*)::int from invites where accepted_at is null and expires_at > now()) as pending_invites,
             (select count(*)::int from api_keys where revoked_at is null) as active_keys
      from users`)).rows[0];
    const perUser = (await db.execute(sql`
      select u.id,
             (select count(*)::int from api_keys k where k.user_id = u.id and k.revoked_at is null) as active_keys,
             greatest((select max(k.last_used_at) from api_keys k where k.user_id = u.id),
                      (select max(s.created_at) from sessions s where s.user_id = u.id)) as last_active,
             (select count(*)::int from audit_events a where a.user_id = u.id and a.created_at > now() - interval '24 hours') as calls_24h
      from users u`)).rows;
    return { scope: 'workspace', calls, perServer, people, perUser };
  });

  // ---- chat agent (C1–C4). Streams Server-Sent Events: model, tool_start, tool_end, text, done | error.
  app.get('/api/chat/status', async req => {
    const { user } = await me(req);
    const models = chat ? [...chat.models, ...(chat.fallback ? [chat.fallback.model] : [])] : [];
    // The agent's tools for this user: the same list this user gets on /mcp, so nothing new is shown.
    const tools = core.listToolsFor(principalOf(user)).map(t => t.name);
    return { enabled: Boolean(chat), model: models[0] ?? null, models, fallback: chat?.fallback?.model ?? null, tools: tools.length, toolNames: tools, confirmWrites: Boolean(chat?.confirmWrites) };
  });
  app.post('/api/chat', async (req, reply) => {
    const { user } = await me(req);
    if (!chat) throw new HttpError(503, 'Chat is not configured: no LLM API key (Gemini or the fallback) in the platform-llm secret.');
    const body = z.object({
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(8000) })).min(1).max(40),
    }).parse(req.body);
    if (body.messages.at(-1)!.role !== 'user') throw new HttpError(400, 'the last message must be from the user');
    // Each message can mean several model calls: limit per user to protect the LLM quota.
    const limit = await chatLimiter.take(`chat:${user.id}`);
    if (!limit.ok) throw new HttpError(429, `Too many chat messages; try again in ${limit.retryAfterS} s.`);

    // A new message means the user moved on: a write still waiting for them is declined (C).
    if (chat.confirmWrites) await declineWaiting(db, user.id);

    const { emit, signal, end } = openStream(reply);
    const principal = principalOf(user);
    const turnId = newRequestId();   // every tool call of this message shares it in the audit
    // AR: with many tools (each bonus store adds six), the model gets the two search-mode tools
    // instead of every schema. Calls through gateway__call_tool are unwrapped, so permissions,
    // confirmation and audit see the real tool.
    const all = core.listToolsFor(principal);
    const toolSearch = all.length > chatToolSearchAbove;
    const direct = execAs(principal, turnId);
    try {
      await runAgent({
        cfg: chat, user, history: body.messages, tools: toolSearch ? searchModeTools : all, toolSearch, emit, signal,
        log: (o, m) => req.log.warn(o, m),
        exec: async (name, args) => {
          if (toolSearch && name === SEARCH_TOOL) {
            const query = typeof args.query === 'string' ? args.query : '';
            const hits = core.searchTools(principal, query, Number(args.limit ?? 10));
            return { text: JSON.stringify({ query, count: hits.length, tools: hits }, null, 2), isError: false, outcome: 'ok', durationMs: 0 };
          }
          const u = toolSearch ? unwrapCall(name, args) : { name, args };
          return direct(u.name, u.args);
        },
        confirm: chat.confirmWrites ? {
          needs: (name, args) => (toolSearch && name === SEARCH_TOOL ? false : core.needsConfirm(toolSearch ? unwrapCall(name, args).name : name)),
          propose: async (name, args) => {
            const u = toolSearch && name === CALL_TOOL ? unwrapCall(name, args) : { name, args };
            const t = manager.resolve(u.name);
            const summary = summarize(t?.definition?.title ?? t?.tool ?? u.name, u.args);
            const row = await createProposal(db, { userId: user.id, tool: u.name, args: u.args, summary, requestId: turnId });
            return { id: row.id, summary };
          },
        } : undefined,
      });
    } catch (e) {
      if (!signal.aborted) {
        req.log.warn({ err: (e as Error).message }, 'chat failed');
        emit({ type: 'error', message: (e as Error).message });
      }
    } finally {
      end();
    }
  });

  // Chat confirmation (C). Only the user the proposal was made for may decide it; it runs through
  // callAsUser like any call, so the role, the tool's permission, pinning, the rate limit and the
  // audit are all checked again now, not when it was proposed. Declining needs no model call.
  app.get('/api/chat/proposals', async req => {
    const { user } = await me(req);
    return { proposals: (await listWaiting(db, user.id)).map(publicProposal) };
  });
  app.post('/api/chat/proposals/:id', async (req, reply) => {
    const { user } = await me(req);
    if (!chat?.confirmWrites) throw new HttpError(404, 'chat confirmation is off');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { decision } = z.object({ decision: z.enum(['confirm', 'reject']) }).parse(req.body);
    if (decision === 'confirm') {
      const limit = await chatLimiter.take(`chat:${user.id}`);
      if (!limit.ok) throw new HttpError(429, `Too many chat messages; try again in ${limit.retryAfterS} s.`);
    }
    const p = await decide(db, id, user.id, decision === 'confirm' ? 'confirmed' : 'rejected')
      .catch(e => { throw e instanceof ProposalError ? new HttpError(e.status, e.message) : e; });
    if (decision === 'reject') return { text: `Cancelled: ${p.summary}. Nothing was changed.` };

    const { emit, signal, end } = openStream(reply);
    const principal = principalOf(user);
    const callId = `confirmed_${p.id}`;
    try {
      emit({ type: 'tool_start', id: callId, name: p.tool, args: p.args });
      const r = await execAs(principal, p.requestId, auditId => setProposalAudit(db, p.id, auditId).catch(e => req.log.warn({ err: String(e) }, 'proposal audit link failed')))(p.tool, p.args as Record<string, unknown>);
      emit({ type: 'tool_end', id: callId, name: p.tool, outcome: r.outcome, durationMs: r.durationMs, preview: r.text.slice(0, 600), isError: r.isError });
      emit({ type: 'text', text: await summarizeConfirmed({ cfg: chat, user, summary: p.summary, name: p.tool, result: r, signal }) });
      emit({ type: 'done', steps: 1 });
    } catch (e) {
      if (!signal.aborted) {
        req.log.warn({ err: (e as Error).message }, 'confirmed chat call failed');
        emit({ type: 'error', message: (e as Error).message });
      }
    } finally {
      end();
    }
  });

  // Kept for scripts (admin API key): live upstream status and exposed tool names.
  app.get('/api/status', async req => {
    await admin(req);
    return { upstreams: manager.snapshot(), exposedTools: manager.listTools().map(t => t.name), rejectedUnauthenticated: counters.rejectedUnauthenticated };
  });
}
