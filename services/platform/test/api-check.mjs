// Dashboard API checks (T1-T6, G1, G5, G7, D9). Creates an invited member, a key and a temporary
// server, and removes the server again. Env: BASE (e.g. http://localhost:9080), ADMIN_EMAIL,
// ADMIN_PASSWORD, SHIP_URL + SHIP_TOKEN (an upstream reachable from the gateway, for server CRUD).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { BASE, ADMIN_EMAIL, ADMIN_PASSWORD, SHIP_URL, SHIP_TOKEN } = process.env;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(50)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(50)} ${e.message}`); }
}

// Minimal browser-like client with a cookie jar.
function session() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = r.headers.getSetCookie?.() ?? [];
    for (const c of set) { const [kv] = c.split(';'); cookie = kv.endsWith('=') ? '' : kv; }
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json, text, setCookie: set };
  };
}
async function mcp(key) {
  const c = new Client({ name: 'api-check', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return c;
}

const admin = session(), member = session(), anon = session();
const memberEmail = `invitee-${Date.now()}@example.com`;
const memberPassword = 'correct-horse-battery-1';
let memberId, memberKey, memberKeyId;

await check('anonymous /api/me -> 401', async () => { const r = await anon('GET', '/api/me'); must(r.status === 401, r.status); return r.text; });
await check('wrong password and unknown email look the same', async () => {
  const a = await anon('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: 'wrong-password-123' });
  const b = await anon('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password-123' });
  must(a.status === 401 && b.status === 401 && a.text === b.text, `${a.status} ${a.text} / ${b.status} ${b.text}`); return a.text;
});
await check('admin login sets an httpOnly SameSite cookie', async () => {
  const r = await admin('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  must(r.status === 200 && r.json.user.role === 'admin', `${r.status} ${r.text}`);
  const c = r.setCookie.join(' ');
  must(/HttpOnly/i.test(c) && /SameSite=Lax/i.test(c), c); return `${r.json.user.email}; ${c.split(';').slice(1).join(';').trim()}`;
});
await check('CSRF: non-JSON POST -> 415, foreign Origin -> 403', async () => {
  const a = await admin('POST', '/api/keys', 'name=x', { 'content-type': 'text/plain' });
  const b = await admin('POST', '/api/keys', { name: 'x' }, { origin: 'https://evil.example' });
  must(a.status === 415 && b.status === 403, `${a.status}/${b.status}`); return `${a.status} ${a.json.error} / ${b.status} ${b.json.error}`;
});

await check('Origin: null -> 403, not 500', async () => {
  const r = await admin('POST', '/api/keys', { name: 'x' }, { origin: 'null' });
  must(r.status === 403, `${r.status} ${r.text}`); return `${r.status} ${r.json.error}`;
});
await check('10 failed logins lock that email (429)', async () => {
  const victim = `nobody-${Date.now()}@example.com`;
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await anon('POST', '/api/auth/login', { email: victim, password: 'wrong-password-123' })).status);
  must(codes.slice(0, 10).every(c => c === 401) && codes[10] === 429, codes.join(','));
  const other = await session()('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  must(other.status === 200, `other account blocked too: ${other.status}`);
  return `10×401 then 429; other accounts unaffected`;
});
let token;
await check('admin invites a member (T5)', async () => {
  const r = await admin('POST', '/api/invites', { email: memberEmail, role: 'member' });
  must(r.status === 200 && r.json.token, `${r.status} ${r.text}`); token = r.json.token;
  return `${r.json.invite.email} ${r.json.invite.status}, link ${r.json.acceptPath.slice(0, 16)}…`;
});
await check('invite lookup + accept logs the member in', async () => {
  const l = await anon('GET', `/api/invites/${token}`);
  must(l.status === 200 && l.json.email === memberEmail, l.text);
  const a = await member('POST', '/api/invites/accept', { token, name: 'Invited Member', password: memberPassword });
  must(a.status === 200 && a.json.user.role === 'member', `${a.status} ${a.text}`); memberId = a.json.user.id;
  const m = await member('GET', '/api/me'); must(m.json.user.email === memberEmail, m.text);
  return `user ${a.json.user.email} (${a.json.user.role}) logged in`;
});
await check('invite cannot be reused', async () => {
  const r = await anon('POST', '/api/invites/accept', { token, password: 'another-password-1' });
  must(r.status === 404, `${r.status}`); return `${r.status} ${r.json.error}`;
});
await check('member gets 403 on admin routes (T1)', async () => {
  const codes = await Promise.all([
    member('GET', '/api/users'), member('POST', '/api/invites', { email: 'x@example.com' }),
    member('POST', '/api/servers', { prefix: 'nope', name: 'n', url: 'http://x' }), member('PATCH', '/api/servers/woo', { enabled: false }),
    member('GET', '/api/status'),
  ]).then(rs => rs.map(r => r.status));
  must(codes.every(c => c === 403), codes.join(',')); return codes.join(',');
});
await check('member sees servers with status and tools (G7)', async () => {
  const r = await member('GET', '/api/servers');
  must(r.status === 200, r.status);
  const summary = r.json.servers.map(s => `${s.prefix}:${s.status}:${s.tools.length}`).join(', ');
  must(r.json.servers.some(s => s.prefix === 'woo' && s.tools.length === 6), summary);
  must(r.json.servers.every(s => s.url === null), 'member can see upstream URLs');
  const a = await admin('GET', '/api/servers');
  must(a.json.servers.every(s => typeof s.url === 'string'), 'admin cannot see URLs');
  must(!/credentialEnc|credential"/.test(r.text) && (!SHIP_TOKEN || !r.text.includes(SHIP_TOKEN)), 'credential material in response');
  return `${summary}; URLs hidden from the member, shown to the admin`;
});
await check('SSRF: metadata, loopback-by-DNS and internal hosts refused (400)', async () => {
  const urls = ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1.nip.io:8080/mcp', 'http://platform-postgres.urumi.svc.cluster.local:5432/'];
  const out = [];
  for (const url of urls) {
    const r = await admin('POST', '/api/servers', { prefix: 'ssrftest', name: 'SSRF test', url, authType: 'none' });
    must(r.status === 400 && /SSRF guard/.test(r.json.error), `${url} -> ${r.status} ${r.text}`);
    out.push(r.json.error.replace('blocked by the SSRF guard: ', ''));
  }
  return out.join(' | ');
});
await check('server URL with a query string or user info -> 400', async () => {
  const q = await admin('POST', '/api/servers', { prefix: 'badurl', name: 'Bad', url: 'https://example.com/mcp?token=abc', authType: 'none' });
  const u = await admin('POST', '/api/servers', { prefix: 'badurl', name: 'Bad', url: 'https://user:pw@example.com/mcp', authType: 'none' });
  must(q.status === 400 && u.status === 400, `${q.status} ${q.text} / ${u.status} ${u.text}`);
  return `${q.json.error} / ${u.json.error}`;
});
await check('Q: sign-ins are recorded with the client address, not a cluster one', async () => {
  // Behind default k3s ServiceLB every client was 10.42.0.1 (shared per-address limits). With
  // Traefik on hostPort (infra/k3s/traefik-hostport.yaml) the address is the client's on the VPS;
  // on k3d it is k3d's load-balancer container, which is still outside the pod and Service ranges.
  const rows = (await admin('GET', '/api/activity?limit=50')).json.events.filter(e => e.action === 'login' && e.actorEmail === ADMIN_EMAIL);
  const ip = rows[0]?.ip ?? '';
  must(ip && !/^(::ffff:)?10\.4[23]\./.test(ip), `sign-in recorded from ${ip || 'nothing'}`);
  return `last sign-in recorded from ${ip}`;
});
await check('B: the gateway refuses itself as an upstream', async () => {
  const r = await admin('POST', '/api/servers', { prefix: 'selfloop', name: 'Self', url: `${BASE}/mcp`, authType: 'none' });
  must(r.status === 400 && /own address/.test(r.json.error ?? ''), `${r.status} ${r.text.slice(0, 160)}`);
  return `${BASE}/mcp -> 400 "${r.json.error.slice(0, 90)}"`;
});
await check('AQ: reserved names refused as credential headers', async () => {
  const out = [];
  for (const h of ['Host', 'Content-Length', 'Transfer-Encoding', 'MCP-Protocol-Version', 'Mcp-Session-Id', 'X-Forwarded-For', 'Cookie']) {
    const r = await admin('POST', '/api/servers', { prefix: 'hdrtest', name: 'Header test', url: 'https://mcp.deepwiki.com/mcp', authType: 'header', authHeaderName: h, credential: 'x' });
    if (r.status !== 400 || !/reserved/.test(r.json.error ?? '')) out.push(`${h}: ${r.status} ${r.text.slice(0, 80)}`);
  }
  must(!out.length, out.join('; '));
  return '7 reserved names (Host, Content-Length, Transfer-Encoding, MCP-*, X-Forwarded-*, Cookie) -> 400 "reserved"';
});
await check('C: when chat asks, per tool; only admins change it', async () => {
  const m = await member('PUT', '/api/servers/woo/confirm', { tool: 'list_orders', mode: 'always' });
  must(m.status === 403, `member -> ${m.status}`);
  const tools = async () => Object.fromEntries((await admin('GET', '/api/servers')).json.servers.flatMap(s => s.tools.map(t => [`${s.prefix}/${t.name}`, t])));
  let t = await tools();
  must(t['woo/create_product']?.asksInChat === true && t['woo/list_orders']?.asksInChat === false, `woo: create ${t['woo/create_product']?.asksInChat}, list ${t['woo/list_orders']?.asksInChat}`);
  const dw = Object.entries(t).filter(([k]) => k.startsWith('deepwiki/'));
  must(dw.every(([, x]) => x.chatConfirm === 'never' && x.asksInChat === false), `deepwiki: ${JSON.stringify(dw.map(([k, x]) => [k, x.chatConfirm]))}`);
  try {
    must((await admin('PUT', '/api/servers/woo/confirm', { tool: 'list_orders', mode: 'always' })).status === 200, 'set always failed');
    t = await tools();
    must(t['woo/list_orders'].chatConfirm === 'always' && t['woo/list_orders'].asksInChat === true, JSON.stringify(t['woo/list_orders'].chatConfirm));
  } finally {
    await admin('PUT', '/api/servers/woo/confirm', { tool: 'list_orders', mode: 'auto' });
  }
  t = await tools();
  must(t['woo/list_orders'].chatConfirm === 'auto' && t['woo/list_orders'].asksInChat === false, 'auto not restored');
  return `member 403; create_product asks, list_orders runs; deepwiki ${dw.length} tools "never" (seed); "always" makes list_orders ask; back to auto`;
});
await check('member creates own API key (T6) and uses it on /mcp', async () => {
  const r = await member('POST', '/api/keys', { name: 'my laptop' });
  must(r.status === 200 && r.json.key.startsWith('urk_'), r.text); memberKey = r.json.key; memberKeyId = r.json.id;
  const c = await mcp(memberKey);
  const res = await c.callTool({ name: 'woo__list_orders', arguments: { per_page: 1 } });
  await c.close();
  must(!res.isError, JSON.stringify(res).slice(0, 100)); return `${r.json.prefix} works; woo__list_orders ok`;
});
await check('key list shows prefix only, never the key', async () => {
  const r = await member('GET', '/api/keys');
  must(r.json.keys.length === 1 && !r.text.includes(memberKey) && !/keyHash|key_hash/.test(r.text), r.text.slice(0, 120));
  return `${r.json.keys.map(k => `${k.prefix} ${k.name}`).join(', ')}`;
});
await check('P: audit CSV is scoped and formula-safe', async () => {
  // A client-chosen tool name that a spreadsheet would run as a formula.
  const c = await mcp(memberKey);
  await c.callTool({ name: '=1+1', arguments: {} }).catch(() => {});
  await c.close();
  const m = await member('GET', '/api/audit/export.csv');
  must(m.status === 200 && m.text.startsWith('"at","user"'), `${m.status} ${m.text.slice(0, 80)}`);
  const lines = m.text.trim().split('\r\n').slice(1);
  must(lines.length >= 2 && lines.every(l => l.includes(`"${memberEmail}"`)), `rows of other users in the member export: ${lines.filter(l => !l.includes(memberEmail)).length}`);
  must(m.text.includes(`"'=1+1"`) && !/,"=1\+1"/.test(m.text), 'formula cell not neutralised');
  const a = await admin('GET', '/api/audit/export.csv');
  must(a.status === 200 && a.text.split('\r\n').length > lines.length, "admin export not wider than the member's");
  return `member export: ${lines.length} rows, all theirs; "=1+1" exported as "'=1+1"`;
});
await check('member audit = own rows only; admin can filter by user (D9)', async () => {
  const m = await member('GET', '/api/audit?limit=50');
  must(m.json.events.length >= 1 && m.json.events.every(e => e.userId === memberId), JSON.stringify(m.json.events.map(e => e.user)));
  const a = await admin('GET', `/api/audit?userId=${memberId}`);
  must(a.json.events.some(e => e.server === 'woo' && e.tool === 'list_orders' && e.outcome === 'ok'), a.text.slice(0, 200));
  const all = await admin('GET', '/api/audit?limit=20');
  return `member sees ${m.json.events.length} own; admin sees ${new Set(all.json.events.map(e => e.user)).size} users in last 20`;
});
await check('activity: member sees own actions only; admin sees all', async () => {
  const m = await member('GET', '/api/activity?limit=50');
  const acts = m.json.events.map(e => e.action);
  must(acts.includes('invite_accepted') && acts.includes('key_created'), acts.join(','));
  must(m.json.events.every(e => e.actorEmail === memberEmail || e.target === memberEmail), 'member sees rows about others');
  must(!m.text.includes(memberKey), 'full key in the activity log');
  const a = await admin('GET', '/api/activity?limit=50');
  must(a.json.events.some(e => e.action === 'invite_sent' && e.target === memberEmail) && a.json.events.some(e => e.action === 'login' && e.actorEmail === ADMIN_EMAIL), 'admin rows missing');
  return `member: ${[...new Set(acts)].join(', ')}; admin also sees invite_sent, login`;
});
await check('member cannot revoke someone else\'s key', async () => {
  const keys = await admin('GET', '/api/keys?all=1');
  const other = keys.json.keys.find(k => k.email !== memberEmail && !k.revokedAt);
  if (!other) return 'skipped (no other active key)';
  const r = await member('DELETE', `/api/keys/${other.id}`);
  must(r.status === 404, `${r.status}`); return `${r.status} ${r.json.error}`;
});
await check('member revokes own key -> /mcp 401', async () => {
  const r = await member('DELETE', `/api/keys/${memberKeyId}`);
  must(r.status === 200, r.text);
  const c = await mcp(memberKey).then(() => 'connected', e => e.message);
  must(/401|Unauthorized|revoked/i.test(c), c); return `revoked; reconnect -> ${c.slice(0, 70)}`;
});

if (SHIP_URL && SHIP_TOKEN) {
  await check('admin adds a server with a bearer credential (G1)', async () => {
    const r = await admin('POST', '/api/servers', { prefix: 'shipcopy', name: 'Ship copy', url: SHIP_URL, authType: 'bearer', credential: SHIP_TOKEN });
    must(r.status === 200, `${r.status} ${r.text}`);
    must(!r.text.includes(SHIP_TOKEN), 'credential echoed back');
    must(r.json.server.hasCredential && r.json.server.status === 'connected' && r.json.server.tools.length === 3, r.text.slice(0, 200));
    const act = (await admin('GET', '/api/activity?limit=20')).json.events.find(e => e.action === 'server_added' && e.target === 'shipcopy');
    must(act && act.detail.credential === 'set' && !JSON.stringify(act).includes(SHIP_TOKEN), `activity: ${JSON.stringify(act)}`);
    return `status ${r.json.server.status}, ${r.json.server.tools.length} tools, hasCredential=true, credential not returned`;
  });
  await check('new server\'s tools are exposed on /mcp', async () => {
    // With several replicas, the one that did not handle the POST learns about the new server
    // through NOTIFY and its own first health check (about a second): wait for it.
    const c = await mcp(process.env.KEY_ADMIN ?? '');
    const t0 = Date.now(); let names = [];
    while (Date.now() - t0 < 15000) {
      const lists = await Promise.all([1, 2, 3, 4].map(() => c.listTools(undefined, { cacheMode: 'bypass' }).then(r => r.tools.map(t => t.name))));
      names = lists.flat();
      if (lists.every(l => l.includes('shipcopy__get_order'))) break;
      await new Promise(r => setTimeout(r, 1000));   // once a second: a slow wait must not use up the key's rate limit
    }
    await c.close();
    must(names.includes('shipcopy__get_order') && Date.now() - t0 < 15000, names.join(','));
    return `shipcopy__get_order listed by every replica after ${Date.now() - t0} ms`;
  });
  await check('disable keeps showing its tools (cache), status Disabled', async () => {
    const r = await admin('PATCH', '/api/servers/shipcopy', { enabled: false });
    must(r.json.server.status === 'disabled' && r.json.server.tools.length === 3, r.text.slice(0, 200));
    must(r.json.server.authType === 'bearer' && r.json.server.hasCredential, `edit changed auth: ${r.json.server.authType} hasCredential=${r.json.server.hasCredential}`);
    return `disabled, ${r.json.server.tools.length} tools still shown, auth unchanged (bearer, credential kept)`;
  });
  await check('wrong credential -> Unreachable with reason', async () => {
    const r = await admin('PATCH', '/api/servers/shipcopy', { enabled: true, credential: 'wrong-token' });
    must(r.json.server.authType === 'bearer' && r.json.server.hasCredential, `auth changed: ${r.json.server.authType}`);
    must(r.json.server.status === 'unreachable' && /unauthorized/.test(r.json.server.error), r.text.slice(0, 200));
    const back = await admin('PATCH', '/api/servers/shipcopy', { credential: SHIP_TOKEN });
    must(back.json.server.status === 'connected', `right credential again -> ${back.json.server.status}`);
    return `${r.json.server.status}: ${r.json.server.error}; right credential -> ${back.json.server.status}`;
  });
  await check('admin removes the server', async () => {
    const r = await admin('DELETE', '/api/servers/shipcopy');
    const l = await admin('GET', '/api/servers');
    must(r.status === 200 && !l.json.servers.some(s => s.prefix === 'shipcopy'), r.text); return 'removed';
  });
}

await check('password change: wrong current 403, then new one works', async () => {
  const a = await member('POST', '/api/me/password', { currentPassword: 'nope-nope-nope', newPassword: 'new-password-2026' });
  const b = await member('POST', '/api/me/password', { currentPassword: memberPassword, newPassword: 'new-password-2026' });
  const c = await anon('POST', '/api/auth/login', { email: memberEmail, password: 'new-password-2026' });
  must(a.status === 403 && b.status === 200 && c.status === 200, `${a.status}/${b.status}/${c.status}`); return `${a.status} / ${b.status} / login ${c.status}`;
});
await check('password change signs out other sessions', async () => {
  const second = session();
  must((await second('POST', '/api/auth/login', { email: memberEmail, password: 'new-password-2026' })).status === 200, 'second login failed');
  must((await member('POST', '/api/me/password', { currentPassword: 'new-password-2026', newPassword: 'newer-password-2026' })).status === 200, 'change failed');
  const a = await member('GET', '/api/me'), b = await second('GET', '/api/me');
  must(a.status === 200 && b.status === 401, `current ${a.status}, other ${b.status}`); return `current session 200, other session ${b.status}`;
});
await check('admin disables the member -> session ends', async () => {
  const r = await admin('PATCH', `/api/users/${memberId}`, { disabled: true });
  const m = await member('GET', '/api/me');
  must(r.status === 200 && m.status === 401, `${r.status}/${m.status}`); return `disabled; member /api/me -> ${m.status}`;
});
await check('logout ends the admin session', async () => {
  await admin('POST', '/api/auth/logout', {});
  const r = await admin('GET', '/api/me'); must(r.status === 401, r.status); return `${r.status}`;
});

console.log(failed ? `API CHECK FAILED (${failed})` : 'API CHECK PASSED');
process.exit(failed ? 1 : 0);
