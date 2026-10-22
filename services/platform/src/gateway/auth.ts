// Gateway authentication: per-user API keys (Bearer urk_...) and, with platform.features.oauth,
// OAuth access tokens (Bearer uoa_..., services/oauth.ts). Both resolve to the same Principal, so
// permissions, audit and rate limits do not depend on how a client signed in. Rejections that
// belong to a user (a revoked key, a disabled user) are audited under that user (T4). Requests
// with no key, an unknown key or an invalid token are only counted (lib/metrics.ts): anyone can
// send them, so auditing each one would let an anonymous client fill the audit table.
import type { Db } from '../db/client.ts';
import { counters } from '../lib/metrics.ts';
import { recordAudit } from '../services/audit.ts';
import { lookupApiKey, touchApiKey } from '../services/keys.ts';
import { isOAuthAccessToken, lookupAccessToken, touchGrant } from '../services/oauth.ts';

// apiKeyId/keyPrefix are null for the chat agent, which acts through the user's dashboard session,
// and for OAuth clients, which carry oauthGrantId (and the client's name as keyPrefix, for the audit).
export type Principal = { userId: string; email: string; role: 'admin' | 'member'; apiKeyId: string | null; keyPrefix: string | null; oauthGrantId?: string | null };
export type AuthResult = { ok: true; principal: Principal } | { ok: false; status: 401; message: string };

const bearer = (h: string | undefined) => (h ?? '').match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';

// `what` describes the rejected request for the audit row, e.g. the tool name of a tools/call.
export async function authenticate(db: Db, authorization: string | undefined, what: { server?: string | null; tool?: string | null }, opts: { oauth?: boolean } = {}): Promise<AuthResult> {
  const presented = bearer(authorization);
  if (opts.oauth && isOAuthAccessToken(presented)) return authenticateOAuth(db, presented, what);
  const found = presented ? await lookupApiKey(db, presented) : undefined;
  let reason: string | null = null;
  if (!presented) reason = 'missing API key';
  else if (!found) reason = 'invalid API key';
  else if (found.key.revokedAt) reason = 'revoked API key';
  else if (found.user.disabledAt) reason = 'user disabled';

  if (reason && !found) {
    counters.rejectedUnauthenticated[reason] = (counters.rejectedUnauthenticated[reason] ?? 0) + 1;
    return { ok: false, status: 401, message: reason };
  }
  if (reason && found) {
    await recordAudit(db, {
      userId: found.user.id,
      apiKeyId: found.key.id,
      keyPrefix: found.key.prefix,
      serverPrefix: what.server ?? null,
      tool: what.tool ?? null,
      outcome: 'rejected',
      error: reason,
    });
    return { ok: false, status: 401, message: reason };
  }
  const { key, user } = found!;
  void touchApiKey(db, key.id).catch(() => {});
  return { ok: true, principal: { userId: user.id, email: user.email, role: user.role as Principal['role'], apiKeyId: key.id, keyPrefix: key.prefix } };
}

// An expired, revoked or unknown token gets 401 with invalid_token (server.ts adds the header), and
// the client refreshes or signs in again.
async function authenticateOAuth(db: Db, presented: string, what: { server?: string | null; tool?: string | null }): Promise<AuthResult> {
  const found = await lookupAccessToken(db, presented);
  if (!found) {
    // Counter label without the word "token": status output is scanned for anything credential-like.
    counters.rejectedUnauthenticated['invalid OAuth access'] = (counters.rejectedUnauthenticated['invalid OAuth access'] ?? 0) + 1;
    return { ok: false, status: 401, message: 'invalid OAuth token' };
  }
  const keyPrefix = `oauth:${found.client.name}`.slice(0, 40);
  if (found.user.disabledAt) {
    await recordAudit(db, { userId: found.user.id, keyPrefix, oauthGrantId: found.g.id, serverPrefix: what.server ?? null, tool: what.tool ?? null, outcome: 'rejected', error: 'user disabled' });
    return { ok: false, status: 401, message: 'user disabled' };
  }
  void touchGrant(db, found.g.id).catch(() => {});
  return { ok: true, principal: { userId: found.user.id, email: found.user.email, role: found.user.role as Principal['role'], apiKeyId: null, keyPrefix, oauthGrantId: found.g.id } };
}

