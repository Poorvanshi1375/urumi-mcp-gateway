// Gateway checks (G2-G5, G7, T2-T4). Mutating steps run admin commands through $CLI, so the same
// script works locally ("node src/cli.ts") and in the cluster ("kubectl exec ... node src/cli.ts").
// Env: GW_URL (base, e.g. http://localhost:8280), KEY_ADMIN, KEY_MEMBER, CLI, and optionally
// ADMIN_EMAIL / MEMBER_EMAIL (the owners of those keys; default alice@ / bob@example.com).
// The member's key is revoked at the end: create a new one before rerunning.
import { execSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { GW_URL, KEY_ADMIN, KEY_MEMBER, CLI, ADMIN_EMAIL = 'alice@example.com', MEMBER_EMAIL = 'bob@example.com' } = process.env;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(46)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(46)} ${e.message}`); }
}
const cli = args => JSON.parse(execSync(`${CLI} ${args}`, { encoding: 'utf8' }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = r => r.content.map(c => c.text ?? '').join(' ');
const rawPost = (key, body) => fetch(`${GW_URL}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify(body),
});
async function connect(key) {
  const c = new Client({ name: 'gateway-check', version: '0.0.1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${GW_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return c;
}
const names = async c => (await c.listTools(undefined, { cacheMode: 'bypass' })).tools.map(t => t.name).sort();
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(250); }
}

const auditStart = new Date();
await check('no key -> 401', async () => { const r = await rawPost(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' }); must(r.status === 401, `${r.status}`); return `${r.status} ${await r.text()}`; });
await check('unknown key -> 401', async () => {
  const r = await rawPost('urk_' + 'x'.repeat(43), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'woo__list_orders', arguments: {} } });
  must(r.status === 401, `${r.status}`); return `${r.status} ${await r.text()}`;
});

const alice = await connect(KEY_ADMIN);
// Precondition: with several gateway replicas, a server re-enabled by an earlier test reaches each
// replica within about a second (NOTIFY, then its own health check). Wait until 4 lists in a row
// (spread over the replicas) show all three servers.
await waitFor(async () => {
  for (let i = 0; i < 4; i++) { const t = await names(alice); if (!['woo', 'ship', 'deepwiki'].every(p => t.some(n => n.startsWith(`${p}__`)))) return false; }
  return true;
}, 30000);
let tools;
await check('tools/list aggregates 3 upstreams (G2, G6)', async () => {
  tools = await names(alice);
  const by = p => tools.filter(t => t.startsWith(`${p}__`)).length;
  must(by('woo') === 5 && by('ship') === 3 && by('deepwiki') >= 1, tools.join(','));
  return `${tools.length} tools: woo ${by('woo')}, ship ${by('ship')}, deepwiki ${by('deepwiki')}`;
});
await check('colliding get_order exposed twice (G3)', async () => {
  must(tools.includes('woo__get_order') && tools.includes('ship__get_order'), 'missing one of them'); return 'woo__get_order, ship__get_order';
});
// The newest order (any store with at least one order; verify-dod places one on an empty store).
const latest = JSON.parse(text(await alice.callTool({ name: 'woo__list_orders', arguments: { per_page: 1 } }))).orders[0];
const track = id => `URS${String(id).padStart(6, '0')}`;
await check('woo__get_order <newest> routes to WooCommerce', async () => {
  must(latest, 'the store has no orders');
  const o = JSON.parse(text(await alice.callTool({ name: 'woo__get_order', arguments: { id: latest.id } })));
  must(o.id === latest.id && o.customer === latest.customer, JSON.stringify(o).slice(0, 100)); return `#${o.id} ${o.customer} ${o.total} ${o.currency}`;
});
await check('ship__get_order <newest> routes to Shipping', async () => {
  const s = JSON.parse(text(await alice.callTool({ name: 'ship__get_order', arguments: { id: latest.id } })));
  must(s.tracking_number?.startsWith(track(latest.id)), JSON.stringify(s).slice(0, 100)); return `${s.carrier} ${s.tracking_number} ${s.status}`;
});
await check('deepwiki__read_wiki_structure', async () => {
  const r = await alice.callTool({ name: 'deepwiki__read_wiki_structure', arguments: { repoName: 'modelcontextprotocol/typescript-sdk' } });
  must(!r.isError, text(r).slice(0, 120)); return `${text(r).length} chars`;
});
await check('unknown tool -> isError', async () => {
  const r = await alice.callTool({ name: 'nope__thing', arguments: {} });
  must(r.isError, 'expected isError'); return text(r);
});
await check('upstream error passes through as tool_error', async () => {
  const r = await alice.callTool({ name: 'woo__get_order', arguments: { id: 999999 } });
  must(r.isError && /404/.test(text(r)), text(r)); return text(r);
});

await check('disable ship -> its tools vanish (G1, C4/D7)', async () => {
  const t0 = Date.now();
  cli('upstreams disable ship');
  const gone = await waitFor(async () => !(await names(alice)).some(t => t.startsWith('ship__')));
  must(gone, 'ship tools still listed after 15 s');
  const ms = Date.now() - t0;
  const r = await alice.callTool({ name: 'ship__get_order', arguments: { id: latest?.id ?? 1 } });
  must(r.isError && /disabled/.test(text(r)), text(r));
  return `gone after ${ms} ms; call -> "${text(r)}"`;
});
await check('enable ship -> tools return', async () => {
  const t0 = Date.now();
  cli('upstreams enable ship');
  const back = await waitFor(async () => (await names(alice)).filter(t => t.startsWith('ship__')).length === 3);
  must(back, 'ship tools not back after 15 s'); return `back after ${Date.now() - t0} ms`;
});

await check('anonymous rejections are counted, not audited', async () => {
  // Counters are per replica: ask a few times so both replicas answer, and add them up.
  const seen = new Map();
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${GW_URL}/api/status`, { headers: { authorization: `Bearer ${KEY_ADMIN}` } });
    seen.set(r.headers.get('x-gateway-replica') ?? 'one', (await r.json()).rejectedUnauthenticated ?? {});
  }
  const sum = k => [...seen.values()].reduce((n, c) => n + (c[k] ?? 0), 0);
  must(sum('missing API key') >= 1 && sum('invalid API key') >= 1, JSON.stringify([...seen]));
  return `${seen.size} replica(s): missing ${sum('missing API key')}, invalid ${sum('invalid API key')} (counted, no audit rows)`;
});
await check('status API: admin 200, member 403 (G7, T1)', async () => {
  const a = await fetch(`${GW_URL}/api/status`, { headers: { authorization: `Bearer ${KEY_ADMIN}` } });
  const b = await fetch(`${GW_URL}/api/status`, { headers: { authorization: `Bearer ${KEY_MEMBER}` } });
  const body = await a.json();
  must(a.status === 200 && b.status === 403, `${a.status}/${b.status}`);
  const leak = JSON.stringify(body).match(/credential|Bearer|token/gi);
  must(!leak, `status leaks ${leak}`);
  return `admin ${a.status} (${body.upstreams.map(u => `${u.prefix}:${u.status}`).join(', ')}), member ${b.status}, no credentials in body`;
});

const bob = await connect(KEY_MEMBER);
await check('member can call tools as himself', async () => {
  const r = await bob.callTool({ name: 'woo__list_orders', arguments: { per_page: 2 } });
  must(!r.isError, text(r).slice(0, 100)); return `${JSON.parse(text(r)).count} orders`;
});
await check('revoke member key -> next call 401 (T2, D6)', async () => {
  const prefix = KEY_MEMBER.slice(0, 12);
  cli(`keys revoke ${prefix}`);
  const r = await rawPost(KEY_MEMBER, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'woo__list_orders', arguments: {} } });
  must(r.status === 401, `${r.status}`); return `${r.status} ${await r.text()}`;
});
await alice.close(); await bob.close().catch(() => {});

await check('audit has calls + rejections by user (T3, T4)', async () => {
  const rows = cli('audit 60').filter(r => new Date(r.at) >= auditStart);
  const fmt = r => `${r.user ?? r.keyPrefix ?? '-'} ${r.server ?? '-'}/${r.tool ?? '-'} ${r.outcome}`;
  const has = (pred, what) => must(rows.some(pred), `no audit row for ${what}`);
  has(r => r.user === ADMIN_EMAIL && r.server === 'woo' && r.tool === 'get_order' && r.outcome === 'ok', 'admin woo get_order ok');
  has(r => r.user === ADMIN_EMAIL && r.server === 'ship' && r.tool === 'get_order' && r.outcome === 'ok', 'admin ship get_order ok');
  has(r => r.user === ADMIN_EMAIL && r.server === 'woo' && r.outcome === 'tool_error', 'admin tool_error');
  has(r => r.user === ADMIN_EMAIL && r.server === 'ship' && r.outcome === 'rejected' && /disabled/.test(r.error), 'call to disabled ship');
  has(r => r.user === MEMBER_EMAIL && r.outcome === 'ok', 'member ok call');
  has(r => r.user === MEMBER_EMAIL && r.outcome === 'rejected' && r.error === 'revoked API key' && r.tool === 'list_orders', 'member revoked-key rejection');
  // Anonymous rejections (no key, unknown key) are counted, not audited: anyone can send them.
  must(!rows.some(r => !r.user && /missing API key|invalid API key/.test(r.error ?? '')), 'anonymous rejection written to the audit log');
  must(rows.every(r => r.durationMs !== null || r.outcome === 'rejected'), 'call rows without duration');
  return `${rows.length} rows since start, e.g. ${rows.slice(0, 4).map(fmt).join(' | ')}`;
});

console.log(failed ? `GATEWAY CHECK FAILED (${failed})` : 'GATEWAY CHECK PASSED');
process.exit(failed ? 1 : 0);
