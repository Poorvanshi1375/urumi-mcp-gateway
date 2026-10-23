// Bonus stores end to end (multi-store, P11), on a cluster with the provisioner and stores on.
// Env: GW_URL, NS, KEY_ADMIN, STORE_CONNECT (host:port the storefronts answer on, e.g. 127.0.0.1:9080;
// default: each store's own URL), STORE_MAX (provisioner.stores.max).
// Side effects, undone before it exits: stores vdodaa, vdodbb, vdodcc and their namespaces; probe pods.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';

const { GW_URL, NS = 'urumi', KEY_ADMIN, STORE_CONNECT, STORE_MAX = '3' } = process.env;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(56)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(56)} ${e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, path, body) {
  const r = await fetch(`${GW_URL}${path}`, { method, headers: { authorization: `Bearer ${KEY_ADMIN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function mcp(method, params) {
  const r = await fetch(`${GW_URL}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${KEY_ADMIN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const t = await r.text();
  return JSON.parse(t.startsWith('{') ? t : (/^data: (.*)$/m.exec(t)?.[1] ?? 'null'));
}
const call = async (name, args = {}) => { const r = await mcp('tools/call', { name, arguments: args }); const t = r?.result?.content?.[0]?.text ?? ''; try { return JSON.parse(t); } catch { return { error: t || JSON.stringify(r).slice(0, 200) }; } };
const toolNames = async () => ((await mcp('tools/list', {}))?.result?.tools ?? []).map(t => t.name);
const store = async slug => (await api('GET', '/api/stores')).body.stores?.find(s => s.slug === slug);
const sh = cmd => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return `ERR ${String(e.stderr || e.message).trim().slice(0, 200)}`; } };
// The storefront as a browser gets it (Traefik routes by Host).
function storefront(url) {
  const u = new URL(url);
  const [host, port] = (STORE_CONNECT ?? `${u.hostname}:${u.port || 80}`).split(':');
  return new Promise(resolve => {
    const req = http.get({ host, port: Number(port), path: '/', headers: { host: u.host }, timeout: 15000 }, res => {
      let body = ''; res.on('data', c => { body += c; }).on('end', () => resolve({ status: res.statusCode, title: /<title>([^<]*)/.exec(body)?.[1] ?? '' }));
    });
    req.on('timeout', () => req.destroy()).on('error', e => resolve({ status: 0, title: e.message }));
  });
}
async function waitReady(slugs, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const all = await Promise.all(slugs.map(store));
    if (all.every(s => s && ['ready', 'failed'].includes(s.state)) || Date.now() > end) return all;
    await sleep(5000);
  }
}
async function removeAll(slugs) {
  for (const slug of slugs) { const s = await store(slug); if (s && s.state !== 'deleting') await api('DELETE', `/api/stores/${s.id}?confirm=${slug}`); }
}
const TEST = ['vdodaa', 'vdodbb', 'vdodcc'];

await removeAll(TEST);
for (let i = 0; i < 90 && (await Promise.all(TEST.map(store))).some(Boolean); i++) await sleep(3000);
try {
  let aa, bb;
  await check('two stores created at the same time both become Ready', async () => {
    const t0 = Date.now();
    const [ra, rb] = await Promise.all([
      api('POST', '/api/stores', { slug: 'vdodaa', title: 'Check Store A', currency: 'USD', country: 'US:NY', timezone: 'America/New_York' }),
      api('POST', '/api/stores', { slug: 'vdodbb', title: 'Check Store B', currency: 'EUR', country: 'DE', timezone: 'Europe/Berlin' }),
    ]);
    must(ra.status === 200 && rb.status === 200, `${ra.status} ${ra.body.error} / ${rb.status} ${rb.body.error}`);
    // Restart the provisioner while both are being set up: leases run out, the steps run again.
    for (let i = 0; i < 40; i++) { const a = await store('vdodaa'); if (['helm', 'setup_job', 'mcp_ready'].includes(a?.step)) break; await sleep(3000); }
    sh(`kubectl delete pod -n ${NS} -l app=provisioner --wait=false`);
    [aa, bb] = await waitReady(['vdodaa', 'vdodbb'], 12 * 60_000);
    must(aa?.state === 'ready' && bb?.state === 'ready', `A ${aa?.state} ${aa?.error ?? ''} / B ${bb?.state} ${bb?.error ?? ''}`);
    const overlap = new Date(aa.createdAt) < new Date(bb.readyAt) && new Date(bb.createdAt) < new Date(aa.readyAt);
    must(overlap, 'the two were not set up at the same time');
    return `both ready after ${Math.round((Date.now() - t0) / 1000)} s, set up in parallel, with the provisioner restarted mid-way`;
  });
  await check('no duplicates after the restart', async () => {
    const rows = sh(`kubectl exec -n ${NS} platform-postgres-0 -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt -c "select prefix || count(*) from upstreams where prefix in ('"'"'vdodaa'"'"','"'"'vdodbb'"'"') group by prefix order by prefix"'`);
    must(rows === 'vdodaa1\nvdodbb1', `upstream rows: ${rows}`);
    return 'one server row per store';
  });
  await check('each storefront is its own store', async () => {
    const [a, b] = await Promise.all([storefront(aa.url), storefront(bb.url)]);
    must(a.status === 200 && b.status === 200 && a.title.includes('Check Store A') && b.title.includes('Check Store B'), JSON.stringify([a, b]));
    return `${aa.url} "${a.title}", ${bb.url} "${b.title}"`;
  });
  await check('each store\'s MCP server answers as that store', async () => {
    const [ia, ib] = await Promise.all([call('vdodaa__get_store_info'), call('vdodbb__get_store_info')]);
    must(ia.name === 'Check Store A' && ia.currency === 'USD' && ib.name === 'Check Store B' && ib.currency === 'EUR' && ia.url && ib.url, JSON.stringify([ia, ib]).slice(0, 240));
    return `A: ${ia.name}, ${ia.currency}, ${ia.timezone}; B: ${ib.name}, ${ib.currency}, ${ib.timezone}`;
  });
  await check('data stays in its store', async () => {
    const p = await call('vdodaa__create_product', { name: 'Only In A', regular_price: '3', status: 'draft', sku: `VDOD-A-${Date.now()}` });
    must(p.id, `create in A: ${JSON.stringify(p).slice(0, 160)}`);
    const [la, lb] = await Promise.all([call('vdodaa__list_products', { search: 'Only In A', status: 'any' }), call('vdodbb__list_products', { search: 'Only In A', status: 'any' })]);
    must(la.count === 1 && lb.count === 0 && la.store?.title === 'Check Store A', JSON.stringify([la.count, lb.count, la.store]));
    return `product #${p.id} in A: listed by A, not by B`;
  });
  await check('stores cannot reach each other', async () => {
    const reach = (from, host, port) => sh(`kubectl exec -n ${from} deploy/store-mcp -- node -e 'const s=require("net").connect({host:"${host}",port:${port},timeout:3000},()=>{console.log("REACHABLE");s.destroy()});s.on("timeout",()=>{console.log("BLOCKED");s.destroy()});s.on("error",()=>console.log("BLOCKED"))'`);
    // A's MCP server may reach its own WordPress (the control: it is listening) but nothing of B.
    const own = reach('store-vdodaa', 'store-wordpress.store-vdodaa.svc.cluster.local', 80);
    const toWp = reach('store-vdodaa', 'store-wordpress.store-vdodbb.svc.cluster.local', 80);
    const toDb = reach('store-vdodaa', 'store-mysql.store-vdodbb.svc.cluster.local', 3306);
    const toPg = reach('store-vdodaa', `platform-postgres.${NS}.svc.cluster.local`, 5432);
    const secret = slug => createHash('sha256').update(sh(`kubectl get secret -n store-${slug} store-secrets -o jsonpath='{.data.mysql-password}{.data.woo-consumer-key}{.data.mcp-token}'`)).digest('hex');
    must(own === 'REACHABLE' && toWp === 'BLOCKED' && toDb === 'BLOCKED' && toPg === 'BLOCKED' && secret('vdodaa') !== secret('vdodbb'), `own ${own}, B's WordPress ${toWp}, B's MySQL ${toDb}, Postgres ${toPg}`);
    return 'A reaches its own WordPress, not B\'s WordPress or MySQL, not Postgres; their secrets differ (compared by hash)';
  });
  await check(`the limit holds (${STORE_MAX} stores); a delete stops an install`, async () => {
    const existing = (await api('GET', '/api/stores')).body.stores.filter(s => s.state !== 'deleting').length;
    const made = [];
    for (let i = existing; i < Number(STORE_MAX); i++) {
      const slug = i === existing ? 'vdodcc' : null;
      if (!slug) break;
      const r = await api('POST', '/api/stores', { slug, title: 'Check Store C' });
      must(r.status === 200, `create ${slug}: ${r.status} ${r.body.error}`); made.push(r.body.store);
    }
    const now = (await api('GET', '/api/stores')).body.stores.filter(s => s.state !== 'deleting').length;
    let limitMsg = 'limit not reached here';
    if (now >= Number(STORE_MAX)) {
      const over = await api('POST', '/api/stores', { slug: 'vdoddd', title: 'One too many' });
      must(over.status === 409 && /limit reached/.test(over.body.error), `over the limit: ${over.status} ${over.body.error}`);
      limitMsg = `store ${now + 1} refused (409 limit reached)`;
    }
    for (const c of made) {
      await sleep(15_000);   // let its install start
      must((await api('DELETE', `/api/stores/${c.id}?confirm=${c.slug}`)).status === 200, 'delete during install refused');
    }
    const wrongConfirm = await api('DELETE', `/api/stores/${aa.id}?confirm=wrong`);
    must(wrongConfirm.status === 400, `delete without the right name: ${wrongConfirm.status}`);
    return `${limitMsg}; a store deleted mid-install is removed; delete needs the store's name typed`;
  });
  await check('delete: tools gone at once, then the namespace and its volumes', async () => {
    const t0 = Date.now();
    must((await api('DELETE', `/api/stores/${bb.id}?confirm=vdodbb`)).status === 200, 'delete refused');
    let gone = 0;
    for (; Date.now() - t0 < 5000; await sleep(200)) if (!(await toolNames()).some(n => n.startsWith('vdodbb__'))) { gone = Date.now() - t0; break; }
    must(gone, 'vdodbb__ tools still listed after 5 s');
    for (let i = 0; i < 60 && (await store('vdodbb')); i++) await sleep(3000);
    const ns = sh('kubectl get ns store-vdodbb -o name');
    const pvs = sh(`kubectl get pv -o jsonpath='{range .items[*]}{.spec.claimRef.namespace}{"\\n"}{end}'`).split('\n').filter(n => n === 'store-vdodbb').length;
    must(!(await store('vdodbb')) && ns.startsWith('ERR') && pvs === 0, `row ${Boolean(await store('vdodbb'))}, namespace ${ns}, volumes ${pvs}`);
    return `tools gone after ${gone} ms; namespace, volumes and row gone after ${Math.round((Date.now() - t0) / 1000)} s`;
  });
} finally {
  await removeAll(TEST);
}
console.log(failed ? `STORES CHECK FAILED (${failed})` : 'STORES CHECK PASSED');
process.exit(failed ? 1 : 0);
