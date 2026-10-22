// Client credentials never reach an upstream (AT): an API key, a session cookie and an OAuth access
// token, sent to /mcp in every place a client might put them (Authorization, Cookie, a custom header,
// the query string), must not appear in what ship-mcp receives. ship-mcp's test tool echo_request
// (ECHO_REQUEST_TOOL=1) returns only SHA-256 hashes of each token-like piece of the request's headers,
// URL and body, so no value is ever printed. The gateway's own bearer token for ship-mcp must be
// there, which proves the method sees credentials at all.
// Env: GW_URL, NS, KEY_ADMIN, ADMIN_EMAIL, ADMIN_PASSWORD, SHIP_TOKEN. Side effects, undone before it
// exits: ship-mcp's ECHO_REQUEST_TOOL is set and cleared (each change restarts ship-mcp); one OAuth
// client "oauth-check (credential isolation)" is registered (verify-dod's cleanup removes it).
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const { GW_URL, NS = 'urumi', KEY_ADMIN, ADMIN_EMAIL, ADMIN_PASSWORD, SHIP_TOKEN } = process.env;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(52)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(52)} ${e.message}`); }
}
const sha = s => createHash('sha256').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function shipEnv(value) {
  const old = execSync(`kubectl get pod -n ${NS} -l app=ship-mcp,app.kubernetes.io/instance=platform -o name`, { encoding: 'utf8' }).trim();
  execSync(`kubectl set env -n ${NS} deploy/platform-ship-mcp ECHO_REQUEST_TOOL${value}`, { stdio: 'ignore' });
  execSync(`kubectl rollout status -n ${NS} deploy/platform-ship-mcp --timeout=120s`, { stdio: 'ignore' });
  if (old) execSync(`kubectl wait -n ${NS} --for=delete ${old.split('\n').join(' ')} --timeout=90s`, { stdio: 'ignore' });
}
// One JSON-RPC request to /mcp with whatever headers and query the test chooses.
async function mcp(method, params, { headers, query = '' }) {
  const r = await fetch(`${GW_URL}/mcp${query}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await r.text();
  const body = text.startsWith('{') ? JSON.parse(text) : JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? 'null');
  return { status: r.status, body };
}
const toolNames = async headers => ((await mcp('tools/list', {}, { headers })).body?.result?.tools ?? []).map(t => t.name);
const echo = async opts => {
  const r = await mcp('tools/call', { name: 'ship__echo_request', arguments: {} }, opts);
  const text = r.body?.result?.content?.[0]?.text;
  must(r.status === 200 && text && !r.body.result.isError, `echo_request -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return JSON.parse(text);
};

// A session cookie and an OAuth access token for the same admin.
const login = await fetch(`${GW_URL}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
must(login.ok, `login -> ${login.status}`);
const sessionCookie = login.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('urumi_session='));
const sessionValue = sessionCookie.split('=')[1];
const REDIRECT = 'http://127.0.0.1:53682/callback';
const reg = await (await fetch(`${GW_URL}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'oauth-check (credential isolation)', redirect_uris: [REDIRECT] }) })).json();
const verifier = randomBytes(32).toString('base64url');
const authorize = await fetch(`${GW_URL}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's', resource: `${GW_URL}/mcp` })}`, { redirect: 'manual' });
const consent = Object.fromEntries(new URL(authorize.headers.get('location'), GW_URL).searchParams);
const approved = await (await fetch(`${GW_URL}/api/oauth/approve`, { method: 'POST', headers: { cookie: sessionCookie, origin: GW_URL, 'content-type': 'application/json' }, body: JSON.stringify(consent) })).json();
const code = new URL(approved.redirect).searchParams.get('code');
const tokens = await (await fetch(`${GW_URL}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }) })).json();
must(tokens.access_token?.startsWith('uoa_'), `no OAuth token: ${JSON.stringify(tokens).slice(0, 120)}`);

const secrets = { 'API key': KEY_ADMIN, 'session cookie': sessionValue, 'OAuth access token': tokens.access_token, 'OAuth refresh token': tokens.refresh_token };
try {
  shipEnv('=1');
  const ready = async () => (await Promise.all([1, 2, 3, 4].map(() => toolNames({ authorization: `Bearer ${KEY_ADMIN}` })))).every(n => n.includes('ship__echo_request'));
  for (let i = 0; i < 30 && !(await ready()); i++) await sleep(1000);

  const leaks = digest => Object.entries(secrets).filter(([, v]) => digest.token_sha256.includes(sha(v))).map(([k]) => k);
  await check('AT: an API key, plus a cookie, header and query copy', async () => {
    const d = await echo({ headers: { authorization: `Bearer ${KEY_ADMIN}`, cookie: `${sessionCookie}; theme=dark`, 'x-api-key': KEY_ADMIN, 'x-auth-token': tokens.access_token },
      query: `?api_key=${encodeURIComponent(KEY_ADMIN)}&access_token=${encodeURIComponent(tokens.access_token)}` });
    must(d.token_sha256.includes(sha(SHIP_TOKEN)), 'the gateway\'s own ship-mcp token is not in the request: the check cannot see credentials');
    must(!leaks(d).length, `reached ship-mcp: ${leaks(d).join(', ')}`);
    must(!d.header_names.some(h => ['cookie', 'x-api-key', 'x-auth-token'].includes(h)), `client headers forwarded: ${d.header_names}`);
    return `none of 4 client credentials reached ship-mcp (headers it got: ${d.header_names.join(', ')}); its own bearer token did`;
  });
  await check('AT: an OAuth access token', async () => {
    const d = await echo({ headers: { authorization: `Bearer ${tokens.access_token}` } });
    must(d.token_sha256.includes(sha(SHIP_TOKEN)) && !leaks(d).length, `reached ship-mcp: ${leaks(d).join(', ') || '(own token missing)'}`);
    return 'the uoa_ token stayed at the gateway; ship-mcp saw only the gateway\'s token';
  });
} finally {
  shipEnv('-');
}
console.log(failed ? `CREDENTIAL ISOLATION CHECK FAILED (${failed})` : 'CREDENTIAL ISOLATION CHECK PASSED');
process.exit(failed ? 1 : 0);
