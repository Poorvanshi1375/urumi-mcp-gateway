// OAuth on the gateway (stand-out 3), end to end against a running gateway with OAUTH on.
// The full flow uses the official MCP SDK client's OAuth support, the same code path MCP clients
// use: discovery from the 401, dynamic registration, PKCE, then tokens on /mcp. The browser part
// (sign in, Allow) is done through the dashboard API with a session, as the consent page does.
// Then the security properties: PKCE and single-use codes, refresh rotation with reuse detection,
// resource binding, revocation and disabling the user.
// Env: GW_URL, KEY_ADMIN (an admin's API key). Creates a member invitee-oauth-<ts>@example.com
// (verify-dod.sh removes invitee-* users afterwards).
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';

const { GW_URL, KEY_ADMIN } = process.env;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(56)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(56)} ${e.message}`); }
}
const MCP = `${GW_URL}/mcp`;
const REDIRECT = 'http://127.0.0.1:53682/callback';
const json = async r => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) });
const admin = (method, path, body) => fetch(`${GW_URL}${path}`, { method, headers: { authorization: `Bearer ${KEY_ADMIN}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(json);
let cookie = '';
const session = (method, path, body) => fetch(`${GW_URL}${path}`, { method, redirect: 'manual',
  headers: { cookie, origin: GW_URL, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) }).then(json);
const form = (path, fields) => fetch(`${GW_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }).then(json);
const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
async function toolsWith(accessToken) {
  const c = new Client({ name: 'oauth-check', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  const names = (await c.listTools(undefined, { cacheMode: 'bypass' })).tools.map(t => t.name);
  await c.close();
  return names;
}
const mcpStatus = token => fetch(MCP, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then(r => r.status);
// Approve an authorization URL as the signed-in member; returns the redirect with code, state, iss.
async function approve(authorizeUrl) {
  const a = await fetch(authorizeUrl, { redirect: 'manual' });
  must(a.status === 302 && a.headers.get('location').startsWith('/oauth/consent?'), `authorize -> ${a.status} ${a.headers.get('location')}`);
  const params = Object.fromEntries(new URL(a.headers.get('location'), GW_URL).searchParams);
  const r = await session('POST', '/api/oauth/approve', params);
  must(r.status === 200 && r.body?.redirect, `approve -> ${r.status} ${JSON.stringify(r.body)}`);
  return new URL(r.body.redirect);
}

// A member to sign in as, through an invite (the way a real teammate joins).
const TS = Date.now();
const email = `invitee-oauth-${TS}@example.com`;
const inv = await admin('POST', '/api/invites', { email, role: 'member' });
const acc = await fetch(`${GW_URL}/api/invites/accept`, { method: 'POST', headers: { 'content-type': 'application/json', origin: GW_URL },
  body: JSON.stringify({ token: inv.body.token, name: 'OAuth check', password: `oc-${randomBytes(9).toString('hex')}` }) });
cookie = (acc.headers.get('set-cookie') ?? '').split(';')[0];
const memberId = (await acc.json()).user.id;

await check('401 tells the client where to get a token', async () => {
  const r = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  const h = r.headers.get('www-authenticate') ?? '';
  must(r.status === 401 && /^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/.test(h), `${r.status} ${h}`);
  return h;
});
await check('discovery documents (RFC 9728, RFC 8414)', async () => {
  const pr = (await fetch(`${GW_URL}/.well-known/oauth-protected-resource/mcp`).then(json)).body;
  const as = (await fetch(`${GW_URL}/.well-known/oauth-authorization-server`).then(json)).body;
  must(pr.resource.endsWith('/mcp') && pr.authorization_servers[0] === as.issuer, JSON.stringify(pr));
  must(as.code_challenge_methods_supported.join() === 'S256' && as.token_endpoint_auth_methods_supported.join() === 'none' && as.authorization_response_iss_parameter_supported, JSON.stringify(as));
  return `resource ${pr.resource}; issuer ${as.issuer}; PKCE S256 only; public clients`;
});
await check('registration refuses plain-http redirects off loopback', async () => {
  const bad = await fetch(`${GW_URL}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] }) }).then(json);
  must(bad.status === 400 && bad.body.error === 'invalid_redirect_uri', JSON.stringify(bad.body));
  return 'http://evil.example/cb -> 400 invalid_redirect_uri';
});

// ---- the SDK client's own flow
let sdkTokens, sdkClientId;
await check('MCP SDK client: discover, register, sign in, tools', async () => {
  let authorizeUrl, verifier, info, discovery;
  const provider = {
    get redirectUrl() { return REDIRECT; },
    get clientMetadata() { return { client_name: 'oauth-check (SDK)', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
    clientInformation: () => info, saveClientInformation: i => { info = i; },
    tokens: () => sdkTokens, saveTokens: t => { sdkTokens = t; },
    redirectToAuthorization: u => { authorizeUrl = u; },
    saveCodeVerifier: v => { verifier = v; }, codeVerifier: () => verifier,
    saveDiscoveryState: d => { discovery = d; }, discoveryState: () => discovery,
  };
  const transport = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider });
  const first = await new Client({ name: 'oauth-check', version: '0' }).connect(transport).then(() => 'connected', e => e);
  must(first instanceof UnauthorizedError && authorizeUrl && info?.client_id, `first connect: ${first?.message ?? first}`);
  const back = await approve(authorizeUrl.toString());
  must(back.searchParams.get('state') === authorizeUrl.searchParams.get('state') && back.searchParams.get('iss'), back.toString());
  await transport.finishAuth(back.searchParams.get('code'), back.searchParams.get('iss'));
  const c = new Client({ name: 'oauth-check', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider }));
  const names = (await c.listTools(undefined, { cacheMode: 'bypass' })).tools.map(t => t.name);
  const r = await c.callTool({ name: 'woo__list_orders', arguments: { per_page: 1 } });
  await c.close();
  sdkClientId = info.client_id;
  must(names.includes('woo__list_orders') && !names.includes('woo__create_product') && !r.isError, `${names.join(',')} ${JSON.stringify(r).slice(0, 100)}`);
  return `${names.length} tools as a member (no create_product); woo__list_orders ok; client ${info.client_id.slice(0, 10)}…`;
});
await check('the OAuth call is audited under the user, via the app', async () => {
  const rows = (await admin('GET', `/api/audit?userId=${memberId}&limit=20`)).body.events;
  const row = rows.find(e => e.tool === 'list_orders');
  must(row?.outcome === 'ok' && row.keyPrefix === 'oauth:oauth-check (SDK)' && row.source === 'mcp', JSON.stringify(rows.slice(0, 3)));
  return `${row.user}, ${row.server}/${row.tool}, ${row.keyPrefix}`;
});

// ---- the protocol rules, by hand
const reg = await fetch(`${GW_URL}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'oauth-check (manual)', redirect_uris: [REDIRECT] }) }).then(json);
const clientId = reg.body.client_id;
const authUrl = (challenge, extra = {}) => `${GW_URL}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', resource: MCP, ...extra })}`;
let tokens;
await check('PKCE: a wrong verifier fails, and the code is then spent', async () => {
  const p = pkce();
  const code = (await approve(authUrl(p.challenge))).searchParams.get('code');
  const wrong = await form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: pkce().verifier });
  const again = await form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: p.verifier });
  must(wrong.status === 400 && wrong.body.error === 'invalid_grant' && again.status === 400 && /already used/.test(again.body.error_description), JSON.stringify([wrong.body, again.body]));
  return `wrong verifier: ${wrong.body.error_description}; retry: ${again.body.error_description}`;
});
await check('code exchange, then reuse of the code revokes its tokens', async () => {
  const p = pkce();
  const code = (await approve(authUrl(p.challenge))).searchParams.get('code');
  const ok = await form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: p.verifier });
  must(ok.status === 200 && ok.body.access_token.startsWith('uoa_') && ok.body.refresh_token.startsWith('uor_') && ok.headers.get('cache-control') === 'no-store', JSON.stringify(ok.body));
  must((await mcpStatus(ok.body.access_token)) === 200, 'fresh token refused');
  await form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: p.verifier });
  must((await mcpStatus(ok.body.access_token)) === 401, 'token still valid after the code was replayed');
  return `access ${ok.body.expires_in} s; replaying the code -> its access token 401`;
});
await check('refresh rotates; a reused refresh token ends the grant', async () => {
  const p = pkce();
  const code = (await approve(authUrl(p.challenge))).searchParams.get('code');
  tokens = (await form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: p.verifier })).body;
  const r1 = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
  must(r1.status === 200 && r1.body.refresh_token !== tokens.refresh_token, JSON.stringify(r1.body));
  must((await mcpStatus(r1.body.access_token)) === 200, 'rotated access token refused');
  const reuse = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
  must(reuse.status === 400 && /reused/.test(reuse.body.error_description), JSON.stringify(reuse.body));
  must((await mcpStatus(r1.body.access_token)) === 401, 'grant still active after refresh-token reuse');
  return 'new pair on refresh; old refresh again -> invalid_grant, every token of the grant 401';
});
await check('tokens are only for this gateway (RFC 8707)', async () => {
  const a = await fetch(authUrl(pkce().challenge, { resource: 'https://elsewhere.example/mcp' }), { redirect: 'manual' });
  const loc = new URL(a.headers.get('location'));
  must(a.status === 302 && loc.origin === new URL(REDIRECT).origin && loc.searchParams.get('error') === 'invalid_target', a.headers.get('location'));
  const u = await fetch(authUrl(pkce().challenge, { redirect_uri: 'https://evil.example/cb' }), { redirect: 'manual' });
  must(u.status === 400 && !u.headers.get('location'), `unregistered redirect -> ${u.status} ${u.headers.get('location')}`);
  return 'other resource -> error=invalid_target; unregistered redirect_uri -> 400, no redirect';
});
await check('approving needs a dashboard session, not a key', async () => {
  const r = await fetch(`${GW_URL}/api/oauth/approve`, { method: 'POST', headers: { authorization: `Bearer ${KEY_ADMIN}`, 'content-type': 'application/json' }, body: '{}' });
  const x = await fetch(`${GW_URL}/api/oauth/approve`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  must(r.status === 403 && x.status === 403, `key ${r.status}, cross-origin ${x.status}`);
  return 'API key -> 403; cross-origin with the session cookie -> 403';
});
await check('disconnecting the app ends its tokens at once', async () => {
  const grants = (await session('GET', '/api/oauth/grants')).body.grants;
  const g = grants.find(x => x.client === 'oauth-check (SDK)');
  must(g, JSON.stringify(grants));
  must((await mcpStatus(sdkTokens.access_token)) === 200, 'SDK token not valid before');
  must((await session('DELETE', `/api/oauth/grants/${g.id}`)).status === 200, 'delete failed');
  const after = await mcpStatus(sdkTokens.access_token);
  const refreshed = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: sdkTokens.refresh_token, client_id: sdkClientId });
  must(after === 401 && refreshed.status === 400 && /revoked/.test(refreshed.body.error_description), `after disconnect: ${after}; refresh ${refreshed.status} ${JSON.stringify(refreshed.body)}`);
  return `${grants.length} connected apps listed; disconnect -> next call 401, refresh refused (grant revoked)`;
});
await check('disabling the user ends every app at once', async () => {
  const p = pkce();
  const code = (await approve(authUrl(p.challenge))).searchParams.get('code');
  const t = (await form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: p.verifier })).body;
  must((await mcpStatus(t.access_token)) === 200, 'token not valid before');
  must((await admin('PATCH', `/api/users/${memberId}`, { disabled: true })).status === 200, 'disable failed');
  const s = await mcpStatus(t.access_token);
  const r = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
  must(s === 401 && r.status === 400, `access ${s}, refresh ${r.status}`);
  return 'access token 401, refresh refused';
});

console.log(failed ? `OAUTH CHECK FAILED (${failed})` : 'OAUTH CHECK PASSED');
process.exit(failed ? 1 : 0);
