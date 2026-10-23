// Hosted MCP servers end to end (stand-out 5, P7), on a cluster with provisioner.enabled. Runs our
// own ship-mcp image as the "admin's image" (it is on every node, so no registry is needed).
// Env: GW_URL, NS, KEY_ADMIN, KEY_MEMBER, SHIP_IMAGE (e.g. urumi-ship-mcp:<tag>).
// Side effects, undone before it exits: hosted servers "vdodev" and "vdodbad" (and their namespaces), one
// probe pod in NS.
import { execSync } from 'node:child_process';

const { GW_URL, NS = 'urumi', KEY_ADMIN, KEY_MEMBER, SHIP_IMAGE } = process.env;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(54)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(54)} ${e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, path, body, key = KEY_ADMIN) {
  const r = await fetch(`${GW_URL}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function mcp(method, params) {
  const r = await fetch(`${GW_URL}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${KEY_ADMIN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const t = await r.text();
  return JSON.parse(t.startsWith('{') ? t : (/^data: (.*)$/m.exec(t)?.[1] ?? 'null'));
}
const toolNames = async () => ((await mcp('tools/list', {}))?.result?.tools ?? []).map(t => t.name);
const hosted = async prefix => (await api('GET', '/api/hosted')).body.servers?.find(s => s.prefix === prefix);
const sh = cmd => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return `ERR ${String(e.stderr || e.message).trim().slice(0, 200)}`; } };
// Connect from inside a pod with node (the hosted image and the gateway both have it).
const reachFrom = (target, host, port) => sh(`kubectl exec ${target} -- node -e 'const s=require("net").connect({host:"${host}",port:${port},timeout:3000},()=>{console.log("REACHABLE");s.destroy()});s.on("timeout",()=>{console.log("BLOCKED");s.destroy()});s.on("error",()=>console.log("BLOCKED"))'`);
async function waitState(prefix, want, ms) {
  const end = Date.now() + ms; let h;
  for (;;) { h = await hosted(prefix); if (!h || want.includes(h.state) || Date.now() > end) return h; await sleep(2000); }
}
async function removeAll() {
  for (const p of ['vdodev', 'vdodbad', 'vdodstdio']) { const h = await hosted(p); if (h && h.state !== 'deleting') await api('DELETE', `/api/hosted/${h.id}`); }
}

must(SHIP_IMAGE, 'SHIP_IMAGE not set');
await removeAll();
for (let i = 0; i < 60 && ((await hosted('vdodev')) || (await hosted('vdodbad'))); i++) await sleep(2000);

try {
  let ev;
  await check('create from an image: Ready, registered, connected', async () => {
    const t0 = Date.now();
    const r = await api('POST', '/api/hosted', { prefix: 'vdodev', name: 'Hosted check', image: SHIP_IMAGE, env: { LOG_LEVEL: 'info' }, secretEnv: { API_TOKEN: 'hosted-check-secret' } });
    must(r.status === 200 && r.body.server?.state === 'provisioning', `create -> ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    ev = await waitState('vdodev', ['ready', 'failed'], 120_000);
    must(ev?.state === 'ready', JSON.stringify(ev).slice(0, 300));
    // Ready means one gateway replica has listed its tools (H7); the others follow within seconds.
    // Wait until every replica (four reads) reports it connected.
    for (let i = 0; i < 20; i++) {
      const reads = await Promise.all([1, 2, 3, 4].map(() => hosted('vdodev')));
      if (reads.every(x => x?.server?.status === 'connected' && x.server.tools > 0)) { ev = reads[0]; break; }
      await sleep(1000);
    }
    must(ev.server?.status === 'connected' && ev.server.tools > 0, `not connected on every replica 20 s after Ready: ${JSON.stringify(ev.server)}`);
    must(!JSON.stringify(await api('GET', '/api/hosted')).includes('hosted-check-secret') && ev.secretEnvKeys.join() === 'API_TOKEN', 'secret env value returned');
    return `ready in ${Math.round((Date.now() - t0) / 1000)} s, ${ev.server.tools} tools, ${ev.image}; secret env shown by name only`;
  });
  await check('its tools work through /mcp and are audited', async () => {
    const names = (await toolNames()).filter(n => n.startsWith('vdodev__'));
    must(names.includes('vdodev__quote_shipping'), `tools: ${names}`);
    const r = await mcp('tools/call', { name: 'vdodev__quote_shipping', arguments: { pincode: '560001', weight_kg: 1 } });
    must(!r.result?.isError && /price_inr/.test(r.result?.content?.[0]?.text ?? ''), JSON.stringify(r).slice(0, 200));
    const audit = (await api('GET', '/api/audit?limit=20')).body.events.find(e => e.server === 'vdodev' && e.tool === 'quote_shipping');
    must(audit?.outcome === 'ok', `audit: ${JSON.stringify(audit)}`);
    return `${names.join(', ')}; quote_shipping ok, audited`;
  });
  await check('isolation: only the gateway reaches it; it reaches nothing', async () => {
    const host = 'mcp.mcp-vdodev.svc.cluster.local';
    const gw = reachFrom(`-n ${NS} deploy/platform -c platform`, host, 8080);
    const probe = `vdod-hosted-probe-${Date.now()}`;
    sh(`kubectl run ${probe} -n ${NS} --labels=vdod=probe,app=intruder --restart=Never --image=busybox:1.37 --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"runAsGroup":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"p","image":"busybox:1.37","securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},"command":["sh","-c","sleep 8; nc -w 3 -z ${host} 8080 && echo REACHABLE || echo BLOCKED"],"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"100m","memory":"32Mi"}}}]}}'`);
    sh(`kubectl wait pod/${probe} -n ${NS} --for=jsonpath='{.status.phase}'=Succeeded --timeout=90s`);
    const other = sh(`kubectl logs -n ${NS} ${probe}`);
    sh(`kubectl delete pod -n ${NS} ${probe} --wait=false`);
    const pod = `-n mcp-vdodev deploy/mcp`;
    const toPg = reachFrom(pod, `platform-postgres.${NS}.svc.cluster.local`, 5432);
    const toNet = reachFrom(pod, '1.1.1.1', 443);
    const toWoo = reachFrom(pod, `platform-woo-mcp.${NS}.svc.cluster.local`, 8080);
    const token = sh(`kubectl exec ${pod} -- node -e 'console.log(require("fs").existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token") ? "TOKEN" : "none")'`);
    must(gw === 'REACHABLE' && other === 'BLOCKED' && toPg === 'BLOCKED' && toNet === 'BLOCKED' && toWoo === 'BLOCKED' && token === 'none',
      `gateway ${gw}, other pod ${other}, to postgres ${toPg}, to internet ${toNet}, to woo-mcp ${toWoo}, token ${token}`);
    return 'gateway reaches it; a pod in the platform namespace cannot; it cannot reach Postgres, woo-mcp or the internet; no API token';
  });
  await check('refused: bad images, names, env; members', async () => {
    const tries = [
      [{ prefix: 'vdodx', name: 'x', image: 'urumi-ship-mcp:latest' }, 400, /latest/],
      [{ prefix: 'vdodx', name: 'x', image: 'ghcr.io/someone/x:1' }, 400, /not allowed/],
      [{ prefix: 'vdodx', name: 'x', image: 'docker.io.evil.com/library/urumi-x:1' }, 400, /not allowed/],
      [{ prefix: 'store', name: 'x', image: SHIP_IMAGE }, 400, /reserved/],
      [{ prefix: 'vdodev', name: 'x', image: SHIP_IMAGE }, 409, /already used/],
      [{ prefix: 'woo', name: 'x', image: SHIP_IMAGE }, 409, /already used/],
      [{ prefix: 'vdodx', name: 'x', image: SHIP_IMAGE, env: { MCP_BEARER_TOKEN: 'x' } }, 400, /set by the platform/],
    ];
    const wrong = [];
    for (const [body, status, msg] of tries) { const r = await api('POST', '/api/hosted', body); if (r.status !== status || !msg.test(r.body.error ?? '')) wrong.push(`${JSON.stringify(body).slice(0, 60)} -> ${r.status} ${r.body.error}`); }
    const m = await api('GET', '/api/hosted', undefined, KEY_MEMBER);
    must(!wrong.length && m.status === 403, `${wrong.join('; ')} | member ${m.status}`);
    return `${tries.length} bad requests refused with the reason; member -> 403`;
  });
  await check('an image that cannot run fails with the cluster\'s reason', async () => {
    const r = await api('POST', '/api/hosted', { prefix: 'vdodbad', name: 'Never starts', image: `${SHIP_IMAGE.split(':')[0]}:no-such-tag` });
    must(r.status === 200, `create -> ${r.status} ${r.body.error}`);
    const h = await waitState('vdodbad', ['failed', 'ready'], 260_000);
    must(h?.state === 'failed' && /pods_ready|workload/.test(`${h.step} ${h.error}`) && /ImagePull|ErrImage|pull/i.test(h.error ?? ''), JSON.stringify(h).slice(0, 300));
    return `failed: ${h.error.slice(0, 110)}`;
  });
  await check('a stdio server, through the bridge (P12)', async () => {
    const r = await api('POST', '/api/hosted', { prefix: 'vdodstdio', name: 'Shipping over stdio', image: SHIP_IMAGE, transport: 'stdio', command: ['node', 'src/stdio.ts'] });
    must(r.status === 200, `create -> ${r.status} ${r.body.error}`);
    let h = await waitState('vdodstdio', ['ready', 'failed'], 150_000);
    must(h?.state === 'ready' && h.transport === 'stdio', JSON.stringify(h).slice(0, 240));
    for (let i = 0; i < 20 && !(h?.server?.tools === 3); i++) { await sleep(1000); h = await hosted('vdodstdio'); }
    must(h.server?.tools === 3, `tools: ${JSON.stringify(h.server)}`);
    const call = await mcp('tools/call', { name: 'vdodstdio__quote_shipping', arguments: { pincode: '560001', weight_kg: 2 } });
    must(!call.result?.isError && /price_inr/.test(call.result?.content?.[0]?.text ?? ''), JSON.stringify(call).slice(0, 200));
    const bad = await api('POST', '/api/hosted', { prefix: 'vdodx', name: 'x', image: SHIP_IMAGE, transport: 'stdio' });
    must(bad.status === 400 && /command/.test(bad.body.error), `stdio without a command: ${bad.status} ${bad.body.error}`);
    await api('DELETE', `/api/hosted/${h.id}`);
    return `ready with 3 tools from "node src/stdio.ts"; quote_shipping answered through the bridge; stdio without a command refused`;
  });
  await check('delete: tools gone at once, then the namespace and the row', async () => {
    const t0 = Date.now();
    must((await api('DELETE', `/api/hosted/${ev.id}`)).status === 200, 'delete refused');
    let gone = 0;
    for (; Date.now() - t0 < 5000; await sleep(200)) if (!(await toolNames()).some(n => n.startsWith('vdodev__'))) { gone = Date.now() - t0; break; }
    must(gone, 'vdodev__ tools still listed after 5 s');
    for (let i = 0; i < 60 && (await hosted('vdodev')); i++) await sleep(2000);
    const ns = sh(`kubectl get ns mcp-vdodev -o name`);
    must(!(await hosted('vdodev')) && ns.startsWith('ERR'), `row ${JSON.stringify(await hosted('vdodev'))}, namespace ${ns}`);
    return `tools gone after ${gone} ms; namespace and row gone after ${Math.round((Date.now() - t0) / 1000)} s`;
  });
} finally {
  await removeAll();
}
console.log(failed ? `HOSTED CHECK FAILED (${failed})` : 'HOSTED CHECK PASSED');
process.exit(failed ? 1 : 0);
