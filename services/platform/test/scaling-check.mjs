// Scaling checks (work item 12), run by scripts/verify-dod.sh when the gateway has 2+ replicas.
// Env: GW_URL, NS, KEY_ADMIN, KEY_MEMBER. Creates and revokes one API key for the rate-limit test.
import { execSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { GW_URL, NS = 'urumi', KEY_ADMIN, KEY_MEMBER } = process.env;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(54)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(54)} ${e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, path, body) {
  const r = await fetch(`${GW_URL}${path}`, { method, headers: { authorization: `Bearer ${KEY_ADMIN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}
// One raw JSON-RPC tools/list on a fresh connection; returns status, replica and tool names.
async function list(key) {
  const r = await fetch(`${GW_URL}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const body = await r.text();
  const json = body.startsWith('{') ? JSON.parse(body) : JSON.parse(body.split('\n').find(l => l.startsWith('data: '))?.slice(6) ?? '{}');
  return { status: r.status, replica: r.headers.get('x-gateway-replica'), retryAfter: r.headers.get('retry-after'), names: (json.result?.tools ?? []).map(t => t.name), error: json.error ?? (r.ok ? null : body) };
}
const pods = () => execSync(`kubectl get pod -n ${NS} -l app=platform,app.kubernetes.io/instance=platform --field-selector=status.phase=Running -o jsonpath='{.items[*].metadata.name}'`, { encoding: 'utf8' }).split(' ').filter(Boolean);
const metricsOf = pod => execSync(`kubectl exec -n ${NS} ${pod} -c platform -- wget -qO- http://127.0.0.1:9464/metrics`, { encoding: 'utf8' });

await check('two or more gateway replicas are ready', async () => {
  const p = pods();
  const ready = execSync(`kubectl get deploy -n ${NS} platform -o jsonpath='{.status.readyReplicas}'`, { encoding: 'utf8' });
  must(p.length >= 2 && Number(ready) >= 2, `${ready} ready: ${p.join(', ')}`);
  const pdb = execSync(`kubectl get pdb -n ${NS} platform -o jsonpath='{.spec.minAvailable}/{.status.currentHealthy}'`, { encoding: 'utf8' });
  return `${ready} ready (${p.join(', ')}); PodDisruptionBudget minAvailable/healthy ${pdb}`;
});
await check('requests are spread over the replicas', async () => {
  const seen = {};
  for (let i = 0; i < 20; i++) { const r = await list(KEY_MEMBER); must(r.status === 200, `${r.status}`); seen[r.replica] = (seen[r.replica] ?? 0) + 1; }
  must(Object.keys(seen).length >= 2, JSON.stringify(seen));
  return `20 tools/list: ${Object.entries(seen).map(([k, v]) => `${k.slice(-5)}=${v}`).join(', ')}`;
});
await check('a disable made via one replica applies on all', async () => {
  await api('PATCH', '/api/servers/ship', { enabled: false });
  try {
    await sleep(1500);
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await list(KEY_MEMBER));
    const stale = results.filter(r => r.names.some(n => n.startsWith('ship__')));
    must(!stale.length, `ship still listed by ${[...new Set(stale.map(r => r.replica))]}`);
    return `12 lists over ${new Set(results.map(r => r.replica)).size} replicas, none with ship__ tools`;
  } finally { await api('PATCH', '/api/servers/ship', { enabled: true }); }
});
await check('rate limit per key is exact across replicas', async () => {
  const k = await api('POST', '/api/keys', { name: 'vdod-ratelimit' });
  try {
    // The bucket is shared by every replica (Postgres), so one key gets `burst` requests at once plus
    // what refills while the test runs, however the requests are spread. Per-replica buckets would
    // let through about replicas x burst.
    const burst = Number(process.env.RATE_BURST ?? 60), perSec = Number(process.env.RATE_PER_MINUTE ?? 120) / 60, n = burst * 3;
    const res = [];
    const t0 = Date.now();
    for (let sent = 0; sent < n; sent += 40) res.push(...await Promise.all(Array.from({ length: Math.min(40, n - sent) }, () => list(k.key))));
    const elapsed = (Date.now() - t0) / 1000;
    const ok = res.filter(r => r.status === 200), limited = res.filter(r => r.status === 429);
    const most = burst + Math.ceil(elapsed * perSec) + 1;
    const replicas = new Set(res.map(r => r.replica)).size;
    must(replicas >= 2, `all requests went to ${replicas} replica`);
    must(ok.length >= burst && ok.length <= most, `${ok.length} allowed; expected ${burst} to ${most} (burst ${burst} + ${elapsed.toFixed(1)} s of refill)`);
    must(limited.length && limited.every(r => Number(r.retryAfter) >= 1) && /rate limit/.test(limited[0].error), JSON.stringify(limited[0]));
    const other = await list(KEY_MEMBER);
    must(other.status === 200, `another key was limited too: ${other.status}`);
    return `${res.length} requests over ${replicas} replicas in ${elapsed.toFixed(1)} s: ${ok.length} allowed (limit ${burst} + refill, at most ${most}), ${limited.length} refused with Retry-After; other keys unaffected`;
  } finally { await api('DELETE', `/api/keys/${k.id}`).catch(() => {}); }
});
await check('/metrics on every replica', async () => {
  const out = [];
  for (const p of pods()) {
    const m = metricsOf(p);
    must(/mcp_upstream_up\{server="woo",status="connected"\} 1/.test(m) && /# TYPE mcp_tool_calls_total counter/.test(m), `${p}: ${m.slice(0, 200)}`);
    const calls = m.split('\n').filter(l => l.startsWith('mcp_tool_calls_total')).reduce((n, l) => n + Number(l.split(' ').pop()), 0);
    const limited = Number(m.match(/mcp_rejected_requests_total\{reason="rate limited"\} (\d+)/)?.[1] ?? 0);
    out.push(`${p.slice(-5)}: ${calls} calls, ${limited} rate-limited`);
  }
  return out.join('; ');
});

console.log(failed ? `SCALING CHECK FAILED (${failed})` : 'SCALING CHECK PASSED');
process.exit(failed ? 1 : 0);
