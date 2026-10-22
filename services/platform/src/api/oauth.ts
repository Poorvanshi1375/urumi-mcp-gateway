// OAuth endpoints (behind platform.features.oauth); the logic and storage are in services/oauth.ts.
//   /.well-known/oauth-protected-resource[/mcp]   RFC 9728: where to get a token for /mcp
//   /.well-known/oauth-authorization-server       RFC 8414: our endpoints and what we support
//   POST /oauth/register                          RFC 7591: a client registers its redirect URIs
//   GET  /oauth/authorize                         checks the request, then hands over to the
//                                                 dashboard's consent page (/oauth/consent)
//   POST /oauth/token                             code -> tokens (PKCE), refresh -> new tokens
//   POST /oauth/revoke                            RFC 7009
// The consent page talks to /api/oauth/* (routes.ts): those are session-authenticated and covered
// by the dashboard's CSRF check (JSON only, same Origin), so approving cannot be forged cross-site.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.ts';
import { RateLimiter } from '../lib/ratelimit.ts';
import { exchangeCode, findClient, OAuthError, redirectMatches, refresh, registerClient, revokeToken, validRedirectUri } from '../services/oauth.ts';

export type OAuthConfig = { enabled: boolean; publicUrl: string };   // publicUrl: e.g. https://app.example.com
export const resourceUrl = (c: OAuthConfig) => `${c.publicUrl}/mcp`;
export const resourceMetadataUrl = (c: OAuthConfig) => `${c.publicUrl}/.well-known/oauth-protected-resource/mcp`;

// The parameters of an authorization request, checked. Problems with client_id or redirect_uri
// must not redirect anywhere ("fatal"); anything else goes back to the client as an OAuth error.
export type AuthorizeRequest = { client: NonNullable<Awaited<ReturnType<typeof findClient>>>; redirectUri: string; state: string | null; codeChallenge: string };
export async function checkAuthorizeRequest(db: Db, cfg: OAuthConfig, q: Record<string, unknown>)
  : Promise<{ ok: AuthorizeRequest } | { fatal: string } | { error: string; description: string; redirectUri: string; state: string | null }> {
  const str = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const clientId = str('client_id'), redirectUri = str('redirect_uri'), state = str('state');
  const client = clientId ? await findClient(db, clientId) : undefined;
  if (!client) return { fatal: 'unknown client_id' };
  if (!redirectUri || !redirectMatches(client.redirectUris as string[], redirectUri)) return { fatal: 'redirect_uri is not registered for this client' };
  const back = (error: string, description: string) => ({ error, description, redirectUri, state });
  if (str('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code');
  if (str('code_challenge_method') !== 'S256') return back('invalid_request', 'PKCE with code_challenge_method S256 is required');
  const codeChallenge = str('code_challenge');
  if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return back('invalid_request', 'code_challenge must be the base64url SHA-256 of the verifier');
  // RFC 8707: tokens from here are only for this gateway's /mcp.
  const resource = str('resource');
  if (resource && resource.replace(/\/$/, '') !== resourceUrl(cfg)) return back('invalid_target', `this server issues tokens only for ${resourceUrl(cfg)}`);
  return { ok: { client, redirectUri, state, codeChallenge } };
}

// Where the browser goes after the user decides: the client's redirect URI with code or error,
// state, and iss (RFC 9207, so the client can tell which server answered).
export function redirectBack(cfg: OAuthConfig, redirectUri: string, params: Record<string, string | null>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set('iss', cfg.publicUrl);
  return u.toString();
}

export function registerOAuth(app: FastifyInstance, db: Db, cfg: OAuthConfig) {
  if (!cfg.enabled) return;
  // Token and revocation requests are form-encoded (RFC 6749).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  const limiter = new RateLimiter(30, 10);   // per client IP, for the unauthenticated endpoints
  const limited = (ip: string, reply: FastifyReply) => {
    const r = limiter.take(ip);
    if (r.ok) return false;
    reply.code(429).header('retry-after', String(r.retryAfterS)).send({ error: 'slow_down', error_description: 'too many requests' });
    return true;
  };
  const oauthError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof OAuthError) return reply.code(e.status).header('cache-control', 'no-store').send({ error: e.code, error_description: e.message });
    throw e;
  };

  const protectedResource = () => ({
    resource: resourceUrl(cfg), authorization_servers: [cfg.publicUrl], bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'], resource_name: 'Urumi Gateway',
  });
  app.get('/.well-known/oauth-protected-resource', async () => protectedResource());
  app.get('/.well-known/oauth-protected-resource/mcp', async () => protectedResource());
  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: cfg.publicUrl,
    authorization_endpoint: `${cfg.publicUrl}/oauth/authorize`,
    token_endpoint: `${cfg.publicUrl}/oauth/token`,
    registration_endpoint: `${cfg.publicUrl}/oauth/register`,
    revocation_endpoint: `${cfg.publicUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    authorization_response_iss_parameter_supported: true,
  }));

  app.post('/oauth/register', async (req, reply) => {
    if (limited(req.ip, reply)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length || uris.length > 10 || uris.some(u => u.length > 2000 || !validRedirectUri(u))) {
      return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris: 1 to 10 https URLs, or http on localhost / 127.0.0.1 / [::1]' });
    }
    const grants = Array.isArray(b.grant_types) ? b.grant_types : ['authorization_code'];
    if (grants.some(g => !['authorization_code', 'refresh_token'].includes(g as string))) {
      return reply.code(400).send({ error: 'invalid_client_metadata', error_description: 'grant_types: authorization_code and refresh_token only' });
    }
    const name = (typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim() : 'MCP client').slice(0, 80);
    try {
      const c = await registerClient(db, name, uris);
      // Every client is public (PKCE, no secret), whatever it asked for (RFC 7591 lets us decide).
      return reply.code(201).send({ client_id: c.clientId, client_id_issued_at: Math.floor(c.createdAt.getTime() / 1000), client_name: c.name,
        redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    } catch (e) { return oauthError(reply, e); }
  });

  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const r = await checkAuthorizeRequest(db, cfg, q);
    if ('fatal' in r) return reply.code(400).type('text/plain').send(`Authorization request refused: ${r.fatal}.`);
    if ('error' in r) return reply.redirect(redirectBack(cfg, r.redirectUri, { error: r.error, error_description: r.description, state: r.state }));
    // Sign-in and consent happen in the dashboard, which has the session.
    return reply.redirect(`/oauth/consent?${new URLSearchParams(q as Record<string, string>).toString()}`);
  });

  app.post('/oauth/token', async (req, reply) => {
    if (limited(req.ip, reply)) return;
    const b = (req.body ?? {}) as Record<string, string>;
    reply.header('cache-control', 'no-store');
    try {
      if (b.resource && b.resource.replace(/\/$/, '') !== resourceUrl(cfg)) throw new OAuthError('invalid_target', `tokens are only for ${resourceUrl(cfg)}`);
      if (!b.client_id) throw new OAuthError('invalid_client', 'client_id is required', 401);
      if (b.grant_type === 'authorization_code') {
        if (!b.code || !b.redirect_uri || !b.code_verifier) throw new OAuthError('invalid_request', 'code, redirect_uri and code_verifier are required');
        const r = await exchangeCode(db, { code: b.code, clientId: b.client_id, redirectUri: b.redirect_uri, codeVerifier: b.code_verifier });
        req.log.info({ client: r.client.name, user: r.user.email, grant: r.grant.id }, 'oauth tokens issued');
        return r.tokens;
      }
      if (b.grant_type === 'refresh_token') {
        if (!b.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required');
        return (await refresh(db, { refreshToken: b.refresh_token, clientId: b.client_id })).tokens;
      }
      throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    } catch (e) { return oauthError(reply, e); }
  });

  app.post('/oauth/revoke', async (req, reply) => {
    if (limited(req.ip, reply)) return;
    const t = ((req.body ?? {}) as Record<string, string>).token;
    if (t) await revokeToken(db, t);
    return reply.code(200).send({});   // RFC 7009: the same answer whether or not the token existed
  });
}
