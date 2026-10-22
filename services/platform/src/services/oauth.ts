// OAuth 2.1 for the gateway (stand-out item 3, behind platform.features.oauth): the authorization
// server and resource server of the MCP authorization specification, for people who already have
// a gateway account. A client such as Claude Code is given only the gateway URL; it discovers the
// endpoints, registers itself, sends the user to the dashboard to sign in and approve, and gets
// tokens that act exactly like that user's API key (same role, permissions, audit and limits).
//   - Public clients only: no client secret; PKCE with S256 is required on every code.
//   - Codes, access tokens and refresh tokens are random 256-bit values stored as SHA-256, like
//     API keys, and checked against the database on every request, so a revocation is immediate.
//   - Access tokens last 15 minutes; refresh tokens rotate on every use, and presenting one that
//     was already used revokes the whole grant (it means the token was copied).
//   - Tokens are bound to this gateway's /mcp URL (RFC 8707): an authorization request for any
//     other resource is refused, and the tokens are never sent to an upstream.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { oauthClients, oauthCodes, oauthGrants, oauthTokens, users } from '../db/schema.ts';
import { sha256 } from '../lib/crypto.ts';

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 5 * 60_000;
export const MAX_CLIENTS = 200;
const UNUSED_CLIENT_DAYS = 30;

const token = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;
export const isOAuthAccessToken = (s: string) => /^uoa_[A-Za-z0-9_-]{43}$/.test(s);

export class OAuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}

// ---- redirect URIs
// https anywhere, or http only on a loopback host (native apps such as Claude Code listen on
// 127.0.0.1 with a random port, RFC 8252). No fragments.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export function validRedirectUri(raw: string): boolean {
  const u = URL.parse(raw);
  if (!u || u.hash || u.username || u.password) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
}
// Exact match, except that a loopback redirect may use any port (the client picks a free one).
export function redirectMatches(registered: string[], presented: string): boolean {
  const p = URL.parse(presented);
  if (!p) return false;
  return registered.some(r => {
    if (r === presented) return true;
    const u = URL.parse(r);
    return Boolean(u && LOOPBACK.has(u.hostname) && u.protocol === p.protocol && u.hostname === p.hostname && u.pathname === p.pathname && u.search === p.search);
  });
}

// ---- PKCE (S256 only)
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const got = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const want = Buffer.from(challenge);
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---- clients (RFC 7591 dynamic registration)
export async function registerClient(db: Db, name: string, redirectUris: string[]) {
  // Open registration is an abuse vector: clients nobody approved for 30 days are dropped, and the
  // total is capped.
  await db.delete(oauthClients).where(and(lt(oauthClients.createdAt, sql`now() - make_interval(days => ${UNUSED_CLIENT_DAYS})`), isNull(oauthClients.lastUsedAt)));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(oauthClients);
  if (n >= MAX_CLIENTS) throw new OAuthError('temporarily_unavailable', 'too many registered clients', 503);
  const [row] = await db.insert(oauthClients).values({ clientId: token('uoc_'), name, redirectUris }).returning();
  return row!;
}
export async function findClient(db: Db, clientId: string) {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
  return row;
}

// ---- authorization codes
export async function issueCode(db: Db, a: { clientRowId: string; userId: string; redirectUri: string; codeChallenge: string }) {
  const code = token('uac_');
  await db.insert(oauthCodes).values({ codeHash: sha256(code), clientId: a.clientRowId, userId: a.userId, redirectUri: a.redirectUri,
    codeChallenge: a.codeChallenge, expiresAt: new Date(Date.now() + CODE_TTL_MS) });
  void db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, sql`now() - interval '1 day'`)).catch(() => {});
  await db.update(oauthClients).set({ lastUsedAt: new Date() }).where(eq(oauthClients.id, a.clientRowId));
  return code;
}

async function issueTokens(db: Db, grantId: string) {
  const access = token('uoa_'), refresh = token('uor_');
  await db.insert(oauthTokens).values([
    { tokenHash: sha256(access), grantId, kind: 'access', expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000) },
    { tokenHash: sha256(refresh), grantId, kind: 'refresh', expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000) },
  ]);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'mcp' };
}

export const revokeGrant = (db: Db, grantId: string) =>
  db.update(oauthGrants).set({ revokedAt: new Date() }).where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt))).returning();

// authorization_code grant. The code is spent atomically; a second use revokes what the first made.
export async function exchangeCode(db: Db, p: { code: string; clientId: string; redirectUri: string; codeVerifier: string }) {
  const client = await findClient(db, p.clientId);
  if (!client) throw new OAuthError('invalid_client', 'unknown client_id', 401);
  const [spent] = await db.update(oauthCodes).set({ usedAt: new Date() })
    .where(and(eq(oauthCodes.codeHash, sha256(p.code)), isNull(oauthCodes.usedAt))).returning();
  if (!spent) {
    const [old] = await db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, sha256(p.code))).limit(1);
    if (old?.grantId) await revokeGrant(db, old.grantId);
    throw new OAuthError('invalid_grant', old ? 'authorization code already used' : 'unknown authorization code');
  }
  if (spent.clientId !== client.id) throw new OAuthError('invalid_grant', 'code was issued to another client');
  if (spent.expiresAt < new Date()) throw new OAuthError('invalid_grant', 'authorization code expired');
  if (spent.redirectUri !== p.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
  if (!pkceMatches(p.codeVerifier, spent.codeChallenge)) throw new OAuthError('invalid_grant', 'code_verifier does not match the code challenge');
  const [user] = await db.select().from(users).where(eq(users.id, spent.userId)).limit(1);
  if (!user || user.disabledAt) throw new OAuthError('invalid_grant', 'user disabled');
  const [grant] = await db.insert(oauthGrants).values({ userId: spent.userId, clientId: client.id }).returning();
  await db.update(oauthCodes).set({ grantId: grant!.id }).where(eq(oauthCodes.codeHash, spent.codeHash));
  return { tokens: await issueTokens(db, grant!.id), grant: grant!, client, user };
}

// refresh_token grant: rotate. A refresh token that was already used means a copy exists.
export async function refresh(db: Db, p: { refreshToken: string; clientId: string }) {
  const client = await findClient(db, p.clientId);
  if (!client) throw new OAuthError('invalid_client', 'unknown client_id', 401);
  const [row] = await db.select({ t: oauthTokens, g: oauthGrants, u: users }).from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId)).innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(eq(oauthTokens.tokenHash, sha256(p.refreshToken)), eq(oauthTokens.kind, 'refresh'))).limit(1);
  if (!row || row.g.clientId !== client.id) throw new OAuthError('invalid_grant', 'unknown refresh token');
  if (row.g.revokedAt) throw new OAuthError('invalid_grant', 'grant revoked');
  if (row.u.disabledAt) throw new OAuthError('invalid_grant', 'user disabled');
  if (row.t.expiresAt < new Date()) throw new OAuthError('invalid_grant', 'refresh token expired');
  const [rotated] = await db.update(oauthTokens).set({ revokedAt: new Date() })
    .where(and(eq(oauthTokens.tokenHash, row.t.tokenHash), isNull(oauthTokens.revokedAt))).returning();
  if (!rotated) {
    await revokeGrant(db, row.g.id);
    throw new OAuthError('invalid_grant', 'refresh token reused; the grant has been revoked');
  }
  return { tokens: await issueTokens(db, row.g.id), grant: row.g, user: row.u };
}

// RFC 7009: revoking a refresh token ends the grant; an access token ends just itself.
export async function revokeToken(db: Db, presented: string) {
  const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, sha256(presented))).limit(1);
  if (!row) return;
  if (row.kind === 'refresh') await revokeGrant(db, row.grantId);
  else await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.tokenHash, row.tokenHash));
}

// Resource server side: an access token on /mcp (or /api). Checked on every request.
export async function lookupAccessToken(db: Db, presented: string) {
  const [r] = await db.select({ t: oauthTokens, g: oauthGrants, user: users, client: oauthClients }).from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthTokens.tokenHash, sha256(presented)), eq(oauthTokens.kind, 'access'), isNull(oauthTokens.revokedAt),
      isNull(oauthGrants.revokedAt), gt(oauthTokens.expiresAt, new Date()))).limit(1);
  return r;
}
export const touchGrant = (db: Db, id: string) =>
  db.update(oauthGrants).set({ lastUsedAt: new Date() })
    .where(and(eq(oauthGrants.id, id), sql`(${oauthGrants.lastUsedAt} is null or ${oauthGrants.lastUsedAt} < now() - interval '60 seconds')`));

// Connected apps for the dashboard: active grants, the user's own or (for admins) everyone's.
export const listGrants = (db: Db, userId?: string) =>
  db.select({ id: oauthGrants.id, client: oauthClients.name, userId: oauthGrants.userId, email: users.email,
    createdAt: oauthGrants.createdAt, lastUsedAt: oauthGrants.lastUsedAt })
    .from(oauthGrants).innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId)).innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(isNull(oauthGrants.revokedAt), userId ? eq(oauthGrants.userId, userId) : undefined))
    .orderBy(sql`${oauthGrants.createdAt} desc`);

export async function revokeGrantOf(db: Db, grantId: string, ownerId?: string) {
  const [row] = await db.update(oauthGrants).set({ revokedAt: new Date() })
    .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt), ownerId ? eq(oauthGrants.userId, ownerId) : undefined)).returning();
  return row;
}
// Disabling a user ends every app they connected.
export const revokeUserGrants = (db: Db, userId: string) =>
  db.update(oauthGrants).set({ revokedAt: new Date() }).where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)));
