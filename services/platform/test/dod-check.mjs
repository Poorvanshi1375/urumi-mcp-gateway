// Definition-of-done checks through the real gateway (D4-D9), run by scripts/verify-dod.sh.
// Uses the same paths a user would: /mcp with an API key, and the dashboard API for admin actions.
// Env: GW_URL, NS, KEY_ADMIN, KEY_MEMBER, ADMIN_EMAIL, MEMBER_EMAIL.
// Side effects, all undone before it exits: disables and re-enables "ship", deletes the ship-mcp
// pod (its Deployment replaces it), revokes KEY_MEMBER.
import { execSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { GW_URL, NS = 'urumi', KEY_ADMIN, KEY_MEMBER, ADMIN_EMAIL, MEMBER_EMAIL } = process.env;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(54)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(54)} ${e.message}`); }
}
const skip = (name, why) => console.log(`SKIP  ${name.padEnd(54)} ${why}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = r => (r.content ?? []).map(c => c.text ?? '').join(' ');
async function waitFor(fn, ms, every = 500) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(every); }
}
const timed = async p => { const t0 = Date.now(); const v = await p; return [v, Date.now() - t0]; };

// Dashboard API with an API key (the API accepts Bearer keys as well as cookies); api() = as the admin.
const api = (method, path, body) => apiAs(KEY_ADMIN, method, path, body);
async function apiAs(key, method, path, body) {
  const r = await fetch(`${GW_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const rawPost = (key, body) => fetch(`${GW_URL}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify(body),
});
async function connect(key) {
  const c = new Client({ name: 'dod-check', version: '0.0.1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${GW_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return c;
}
const names = async c => (await c.listTools(undefined, { cacheMode: 'bypass' })).tools.map(t => t.name);
const server = async prefix => (await api('GET', '/api/servers')).servers.find(s => s.prefix === prefix);

const startedAt = new Date().toISOString();

console.log('--- D6 prerequisite: the gateway rejects requests without a valid key');
await check('/mcp without a key -> 401', async () => {
  const r = await rawPost(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  must(r.status === 401, `${r.status}`); return `${r.status} ${await r.text()}`;
});
await check('/mcp with an unknown key -> 401', async () => {
  const r = await rawPost('urk_' + 'x'.repeat(43), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  must(r.status === 401, `${r.status}`); return `${r.status} ${await r.text()}`;
});

const member = await connect(KEY_MEMBER);
const admin = await connect(KEY_ADMIN);

console.log('--- D4: member B sees the tools of every enabled server with only URL + key');
await check('every enabled server is connected', async () => {
  const servers = (await api('GET', '/api/servers')).servers;
  const bad = servers.filter(s => s.enabled && s.status !== 'connected');
  must(!bad.length, bad.map(s => `${s.prefix}:${s.status} (${s.error})`).join(', '));
  return servers.map(s => `${s.prefix}:${s.status}`).join(', ');
});
await check('member tools/list has namespaced tools of each server', async () => {
  const servers = (await api('GET', '/api/servers')).servers.filter(s => s.enabled);
  const tools = await names(member);
  const counts = servers.map(s => [s.prefix, tools.filter(t => t.startsWith(`${s.prefix}__`)).length]);
  must(counts.every(([, n]) => n > 0), counts.map(c => c.join(' ')).join(', '));
  must(tools.every(t => /^[a-z0-9]{2,12}__[A-Za-z0-9_-]+$/.test(t)), `badly formed: ${tools.filter(t => !/^[a-z0-9]{2,12}__/.test(t))}`);
  return `${tools.length} tools: ${counts.map(c => c.join(' ')).join(', ')}`;
});
await check('colliding get_order is exposed once per server (G3)', async () => {
  const tools = await names(member);
  must(tools.includes('woo__get_order') && tools.includes('ship__get_order'), 'one of them is missing');
  return 'woo__get_order and ship__get_order both listed';
});
console.log('--- Tool permissions: members are read-only on the store (stand-out item 2)');
const RESTRICTED = ['woo__create_product', 'woo__update_order_status'];
await check('member list omits admin-only tools; admin sees them', async () => {
  const m = await names(member), a = await names(admin);
  must(RESTRICTED.every(t => !m.includes(t)), `member sees ${RESTRICTED.filter(t => m.includes(t))}`);
  must(RESTRICTED.every(t => a.includes(t)), 'admin is missing a woo tool');
  const mc = (await apiAs(KEY_MEMBER, 'GET', '/api/chat/status')).tools, ac = (await api('GET', '/api/chat/status')).tools;
  must(mc === m.length && ac === a.length, `chat agent: member ${mc}, admin ${ac}`);
  return `member ${m.length} tools, admin ${a.length}; chat agent sees the same (${mc} / ${ac})`;
});
await check('member calling woo__create_product directly -> denied', async () => {
  const r = await member.callTool({ name: 'woo__create_product', arguments: { name: 'DOD should not exist', regular_price: '1', status: 'draft' } });
  must(r.isError && /not available to your role/.test(text(r)), text(r)); return text(r);
});
await check('admin hides ship__quote_shipping from members -> gone, then restored', async () => {
  const before = await names(member);
  must(before.includes('ship__quote_shipping'), 'member could not see it to begin with');
  const m403 = await fetch(`${GW_URL}/api/servers/ship/permissions`, { method: 'PUT', headers: { authorization: `Bearer ${KEY_MEMBER}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'quote_shipping', memberAllowed: false }) });
  must(m403.status === 403, `member could change permissions: ${m403.status}`);
  await api('PUT', '/api/servers/ship/permissions', { tool: 'quote_shipping', memberAllowed: false });
  const gone = await waitFor(async () => !(await names(member)).includes('ship__quote_shipping'), 10000);
  await api('PUT', '/api/servers/ship/permissions', { tool: 'quote_shipping', memberAllowed: true });
  must(gone, 'still listed for the member after 10 s');
  const back = await waitFor(async () => (await names(member)).includes('ship__quote_shipping'), 10000);
  must(back, 'not back after restoring');
  return 'member PUT 403; hidden for the member, admin unaffected; restored';
});

console.log('--- D4/D5: the orders question, and one task that needs two servers');
let latest;
// "today" is resolved by woo-mcp in the store's own timezone, as for the chat agent.
await check('member: "orders today" via woo__list_orders', async () => {
  const r = await member.callTool({ name: 'woo__list_orders', arguments: { created_on: 'today' } });
  must(!r.isError, text(r).slice(0, 160));
  const j = JSON.parse(text(r));
  // The store computes the day's total exactly (idea A); check it against our own sum in cents.
  const cents = j.orders.reduce((n, o) => n + BigInt(Math.round(Number(o.total) * 100)), 0n);
  const stated = j.amount_total === null ? null : BigInt(j.amount_total.replace('.', '').padEnd(1, '0')) * (j.amount_total.includes('.') ? 10n ** BigInt(2 - j.amount_total.split('.')[1].length) : 100n);
  must(j.complete === true && j.total_orders === j.count && (j.count === 0 || stated === cents), `amount_total ${j.amount_total} vs ${cents} cents; complete ${j.complete}; ${j.total_orders}/${j.count}`);
  return `${j.count} order(s) on ${j.created_on} (the store's today), total ${j.amount_total} ${j.currency ?? ''}, complete${j.count ? ': ' + j.orders.map(o => `#${o.id} ${o.total} ${o.currency}`).join(', ') : ' (call succeeded; place an order to see one)'}`;
});
const anyOrder = JSON.parse(text(await member.callTool({ name: 'woo__list_orders', arguments: { per_page: 1 } }))).count > 0;
if (!anyOrder) skip('member: latest order from woo, then its shipment from ship', 'the store has no orders yet (place one on the storefront)');
else await check('member: latest order from woo, then its shipment from ship', async () => {
  const r = await member.callTool({ name: 'woo__list_orders', arguments: { per_page: 1 } });
  must(!r.isError, text(r).slice(0, 160));
  latest = JSON.parse(text(r)).orders[0];
  must(latest, 'the store has no orders');
  const s = await member.callTool({ name: 'ship__get_order', arguments: { id: latest.id } });
  must(!s.isError, text(s).slice(0, 160));
  const j = JSON.parse(text(s));
  return `woo #${latest.id} (${latest.status}) -> ship ${j.carrier} ${j.tracking_number} ${j.status}`;
});

// Idea A on real data: the busiest recent day (most orders among the last 100), so the store's
// exact total is checked over several amounts, not an empty or one-order day.
if (anyOrder) await check('A: the store\'s day total equals our own sum (busiest recent day)', async () => {
  const recent = JSON.parse(text(await member.callTool({ name: 'woo__list_orders', arguments: { per_page: 100 } }))).orders;
  const byDay = new Map();
  for (const o of recent) { const d = o.date_created.slice(0, 10); byDay.set(d, (byDay.get(d) ?? 0) + 1); }
  const [day] = [...byDay].sort((a, b) => b[1] - a[1])[0];
  const j = JSON.parse(text(await member.callTool({ name: 'woo__list_orders', arguments: { created_on: day } })));
  const cents = j.orders.reduce((n, o) => n + BigInt(Math.round(Number(o.total) * 100)), 0n);
  const [i, f = ''] = j.amount_total.replace('-', '').split('.');
  const stated = (j.amount_total.startsWith('-') ? -1n : 1n) * BigInt(i + f.padEnd(2, '0').slice(0, 2));
  const statuses = Object.values(j.count_by_status).reduce((a, b) => a + b, 0);
  must(j.count >= 1 && stated === cents && j.complete === true && j.total_orders === j.count && statuses === j.count,
    `${day}: amount_total ${j.amount_total} vs ${cents} cents; complete ${j.complete}; total_orders ${j.total_orders}, count ${j.count}`);
  return `${day}: ${j.count} orders, amount_total ${j.amount_total} ${j.currency} = our sum; ${JSON.stringify(j.count_by_status)}`;
});

console.log('--- D7: disabling a server removes its tools from the external client and the chat agent');
await check('admin disables ship -> member list drops ship__ tools', async () => {
  const before = (await apiAs(KEY_MEMBER, 'GET', '/api/chat/status')).tools;
  const shipTools = (await names(member)).filter(t => t.startsWith('ship__')).length;
  const t0 = Date.now();
  await api('PATCH', '/api/servers/ship', { enabled: false });
  // Requests are spread over the replicas; the one that did not handle the PATCH learns through
  // NOTIFY (about a second). Wait until no replica's /mcp list and no replica's chat agent has a
  // ship tool, by name. (Not "the count dropped by ship's tools": a third-party server such as
  // DeepWiki can come back during the wait, as it did on 22 Oct, and refill the count.) Polls once a
  // second so a slow wait cannot use up the key's rate limit.
  let after, mcpCount;
  const gone = await waitFor(async () => {
    const lists = await Promise.all([1, 2, 3, 4].map(() => names(member)));
    const chats = await Promise.all([1, 2, 3, 4].map(async () => (await apiAs(KEY_MEMBER, 'GET', '/api/chat/status')).toolNames ?? []));
    after = chats.map(c => c.length).join('/'); mcpCount = lists.map(l => l.length).join('/');
    return [...lists, ...chats].every(l => !l.some(t => t.startsWith('ship__')));
  }, 15000, 1000);
  const ms = Date.now() - t0;
  must(shipTools > 0 && gone, `after 15 s: chat agents have ${after} tools (before ${before}, ship had ${shipTools}), /mcp ${mcpCount}; a ship__ tool is still listed`);
  return `gone from /mcp after ${ms} ms; chat agent tool count ${before} -> ${after}`;
});
await check('a direct call to the disabled server is rejected', async () => {
  const r = await member.callTool({ name: 'ship__get_order', arguments: { id: latest?.id ?? 16 } });
  must(r.isError && /disabled/.test(text(r)), text(r)); return text(r);
});
await check('admin re-enables ship -> tools return', async () => {
  const t0 = Date.now();
  await api('PATCH', '/api/servers/ship', { enabled: true });
  const back = await waitFor(async () => (await names(member)).some(t => t.startsWith('ship__')), 30000);
  must(back, 'ship tools not back after 30 s'); return `back after ${Date.now() - t0} ms`;
});

console.log('--- D8: a dead upstream does not affect the others, shows Unreachable, recovers');
const SHIP = `-n ${NS} deploy/platform-ship-mcp`;
// 1. Kill the pod. Its Deployment replaces it within seconds (on a fast node faster than the 10 s
//    health interval, so Unreachable may never show). What must hold: the others keep working and
//    ship comes back on its own.
await check('delete the ship-mcp pod -> others unaffected, ship self-heals', async () => {
  const pod = execSync(`kubectl get pod -n ${NS} -l app=ship-mcp,app.kubernetes.io/instance=platform -o name`, { encoding: 'utf8' }).trim();
  must(pod, 'no ship-mcp pod found');
  const t0 = Date.now();
  execSync(`kubectl delete -n ${NS} ${pod} --wait=false`, { stdio: 'ignore' });
  let sawUnreachable = false, wooFailures = 0, wooCalls = 0;
  const healed = await waitFor(async () => {
    const w = await admin.callTool({ name: 'woo__list_orders', arguments: { per_page: 1 } }); wooCalls++; if (w.isError) wooFailures++;
    const s = await server('ship'); if (s.status === 'unreachable') sawUnreachable = true;
    // Healed = the old pod is gone (not just terminating), a new one exists, ship is connected.
    const pods = execSync(`kubectl get pod -n ${NS} -l app=ship-mcp,app.kubernetes.io/instance=platform -o name`, { encoding: 'utf8' }).split('\n').filter(Boolean);
    return pods.length > 0 && !pods.includes(pod) && s.status === 'connected' && (await names(member)).some(t => t.startsWith('ship__'));
  }, 120000, 500);
  must(healed, `ship not back after 120 s (${(await server('ship')).status})`);
  must(wooFailures === 0, `${wooFailures} of ${wooCalls} woo calls failed while ship was being replaced`);
  return `${pod} replaced and ship Connected after ${Date.now() - t0} ms; ${wooCalls} woo calls meanwhile, all ok; Unreachable ${sawUnreachable ? 'seen' : 'not seen (replaced between health checks)'}`;
});
// 2. Stop the server completely (no pods): this is the state the dashboard must show.
await check('stop ship (0 pods) -> ship shows Unreachable', async () => {
  const t0 = Date.now();
  const pods = execSync(`kubectl get pod -n ${NS} -l app=ship-mcp,app.kubernetes.io/instance=platform -o name`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  execSync(`kubectl scale ${SHIP} --replicas=0`, { stdio: 'ignore' });
  // A pod being stopped still answers for a few seconds (its preStop pause), and each replica learns
  // of the outage at its own health check: the checks below start only when the pod is gone and
  // every replica says Unreachable (four reads, spread over the replicas).
  if (pods.length) execSync(`kubectl wait -n ${NS} --for=delete ${pods.join(' ')} --timeout=90s`, { stdio: 'ignore' });
  const s = await waitFor(async () => { const all = await Promise.all([1, 2, 3, 4].map(() => server('ship'))); return all.every(x => x.status === 'unreachable') && all[0]; }, 90000, 300);
  must(s, `ship still ${(await server('ship')).status} after 90 s`);
  return `scaled to 0; pod gone and Unreachable on every replica after ${Date.now() - t0} ms: ${s.error}`;
});
await check('while ship is down: list is fast and has woo, not ship', async () => {
  const [tools, ms] = await timed(names(member));
  must(!tools.some(t => t.startsWith('ship__')) && tools.some(t => t.startsWith('woo__')), tools.join(','));
  return `${tools.length} tools in ${ms} ms`;
});
await check('while ship is down: woo call works, ship call fails fast', async () => {
  const [w, wms] = await timed(admin.callTool({ name: 'woo__list_orders', arguments: { per_page: 1 } }));
  must(!w.isError, text(w).slice(0, 120));
  const [s, sms] = await timed(member.callTool({ name: 'ship__get_order', arguments: { id: latest?.id ?? 16 } }));
  must(s.isError && sms < 5000, `${sms} ms: ${text(s)}`);
  return `woo ok in ${wms} ms; ship error in ${sms} ms: "${text(s).slice(0, 70)}"`;
});
await check('start ship again -> Connected, tools return', async () => {
  const t0 = Date.now();
  execSync(`kubectl scale ${SHIP} --replicas=1`, { stdio: 'ignore' });
  const s = await waitFor(async () => { const s = await server('ship'); return s.status === 'connected' && s; }, 120000, 1000);
  must(s, `ship still ${(await server('ship')).status} after 120 s`);
  const back = await waitFor(async () => (await names(member)).some(t => t.startsWith('ship__')), 15000);
  must(back, 'connected, but tools not listed');
  // The outage stays visible after recovery (the dashboard shows "recovered ... after ..."). Each
  // replica keeps its own; wait until the one answering has recovered too.
  const o = await waitFor(async () => { const x = await server('ship'); return x.status === 'connected' && x.lastOutage?.to && x.lastOutage; }, 30000, 500);
  must(o?.to && o.reason && new Date(o.to) > new Date(o.from), `lastOutage: ${JSON.stringify(o)}`);
  return `connected again after ${Date.now() - t0} ms; last outage kept: ${Math.round((new Date(o.to) - new Date(o.from)) / 1000)} s, "${o.reason.slice(0, 50)}"`;
});

console.log('--- D6: revoking a key rejects the next call');
await check('admin revokes member key -> next /mcp call 401', async () => {
  const prefix = KEY_MEMBER.slice(0, 12);
  const key = (await api('GET', '/api/keys?all=1')).keys.find(k => k.prefix === prefix && !k.revokedAt);
  must(key, `no active key with prefix ${prefix}`);
  await api('DELETE', `/api/keys/${key.id}`);
  const r = await rawPost(KEY_MEMBER, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'woo__list_orders', arguments: {} } });
  must(r.status === 401, `${r.status}`); return `${r.status} ${await r.text()}`;
});
await member.close().catch(() => {}); await admin.close().catch(() => {});

console.log('--- D9: every call above is in the audit log under the right user');
await check('audit rows for member B, attributed to B', async () => {
  const u = (await api('GET', '/api/users')).users.find(x => x.email === MEMBER_EMAIL);
  const rows = (await api('GET', `/api/audit?userId=${u.id}&limit=200`)).events.filter(e => e.at >= startedAt);
  const has = (pred, what) => must(rows.some(pred), `no row for ${what}; rows: ${rows.map(r => `${r.server}/${r.tool}:${r.outcome}`).join(' ')}`);
  has(r => r.server === 'woo' && r.tool === 'list_orders' && r.outcome === 'ok' && r.source === 'mcp', 'woo list_orders ok');
  if (anyOrder) has(r => r.server === 'ship' && r.tool === 'get_order' && r.outcome === 'ok', 'ship get_order ok');
  has(r => r.server === 'ship' && r.outcome === 'rejected' && /disabled/.test(r.error ?? ''), 'call to disabled ship');
  has(r => r.server === 'ship' && ['upstream_unreachable', 'rejected'].includes(r.outcome) && !/disabled/.test(r.error ?? ''), 'call while ship was down');
  has(r => r.outcome === 'rejected' && r.error === 'revoked API key', 'revoked-key rejection');
  has(r => r.server === 'woo' && r.tool === 'create_product' && r.outcome === 'denied', 'denied create_product');
  must(rows.every(r => r.user === MEMBER_EMAIL), 'a row under another user');
  must(rows.every(r => r.outcome === 'rejected' || r.durationMs !== null), 'a call row without a duration');
  const by = {}; for (const r of rows) by[r.outcome] = (by[r.outcome] ?? 0) + 1;
  return `${rows.length} rows: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')}`;
});
await check('audit rows for admin A, attributed to A', async () => {
  const u = (await api('GET', '/api/users')).users.find(x => x.email === ADMIN_EMAIL);
  const rows = (await api('GET', `/api/audit?userId=${u.id}&limit=200`)).events.filter(e => e.at >= startedAt);
  must(rows.some(r => r.server === 'woo' && r.tool === 'list_orders' && r.outcome === 'ok'), 'no woo call row');
  must(rows.every(r => r.user === ADMIN_EMAIL), 'a row under another user');
  return `${rows.length} row(s), e.g. ${rows.map(r => `${r.server}/${r.tool}:${r.outcome} ${r.durationMs} ms`)[0]}`;
});

await check('activity log has the admin actions above, by A', async () => {
  const rows = (await api('GET', '/api/activity?limit=200')).events.filter(e => e.createdAt >= startedAt && e.actorEmail === ADMIN_EMAIL);
  const has = (action, target, what) => must(rows.some(e => e.action === action && e.target === target), `no ${what}; got ${rows.map(e => `${e.action}:${e.target}`).join(' ')}`);
  has('server_disabled', 'ship', 'ship disabled'); has('server_enabled', 'ship', 'ship enabled');
  has('permission_changed', 'ship', 'permission change'); has('key_revoked', MEMBER_EMAIL, "revoke of B's key");
  must(!JSON.stringify(rows).includes(KEY_MEMBER), 'a full API key in the activity log');
  return rows.map(e => `${e.action}:${e.target}`).join(', ');
});

await check('one request id: client response, audit row, woo-mcp log', async () => {
  let rid = null;
  const c = new Client({ name: 'dod-trace', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${GW_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${KEY_ADMIN}` } },
    fetch: (u, i) => fetch(u, i).then(r => { if (i?.body?.includes?.('tools/call')) rid = r.headers.get('x-request-id'); return r; }) }));
  const r = await c.callTool({ name: 'woo__list_orders', arguments: { per_page: 1 } });
  await c.close();
  must(!r.isError && /^[0-9a-f]{32}$/.test(rid ?? ''), `request id ${rid}`);
  const rows = (await api('GET', `/api/audit?requestId=${rid}`)).events;
  must(rows.length === 1 && rows[0].tool === 'list_orders' && rows[0].outcome === 'ok', JSON.stringify(rows));
  const logged = await waitFor(async () => execSync(`kubectl logs -n ${NS} deploy/platform-woo-mcp --since=5m`, { encoding: 'utf8' }).includes(rid), 10000, 1000);
  must(logged, `request ${rid} not in the woo-mcp log`);
  return `x-request-id ${rid.slice(0, 12)}…: one audit row (woo/list_orders ok) and the woo-mcp log line`;
});

await check('every audit row of this run is complete (write-ahead audit)', async () => {
  const rows = (await api('GET', '/api/audit?limit=200')).events.filter(e => e.at >= startedAt);
  const open = rows.filter(r => r.outcome === 'pending' || r.outcome === 'unknown');
  must(rows.length && !open.length, `${open.length} of ${rows.length} rows not completed: ${JSON.stringify(open.slice(0, 2))}`);
  return `${rows.length} rows since the start, none pending or unknown`;
});
await check('overview: calls, error rate and latency per server', async () => {
  const o = await api('GET', '/api/overview');
  const woo = o.perServer.find(x => x.server === 'woo');
  must(woo && woo.calls > 0 && Number.isInteger(woo.p50_ms) && Number.isInteger(woo.p95_ms) && woo.p95_ms >= woo.p50_ms, JSON.stringify(o.perServer));
  return o.perServer.map(x => `${x.server}: ${x.calls} calls, ${x.errors} failed, p50 ${x.p50_ms ?? '-'} / p95 ${x.p95_ms ?? '-'} ms`).join('; ');
});

console.log(failed ? `DOD CHECK FAILED (${failed})` : 'DOD CHECK PASSED');
process.exit(failed ? 1 : 0);
