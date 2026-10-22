// Idea R, against the running gateway: an address that keeps failing /mcp authentication gets 429
// before any key lookup, and a valid key works again once the failures stop. Run last by
// verify-dod.sh: locally every request comes from k3d's load balancer, so the flood briefly
// throttles everything from this machine. Env: GW_URL, KEY (a valid API key), LIMIT (per minute).
const { GW_URL, KEY, LIMIT = '30' } = process.env;
const must = (c, m) => { if (!c) throw new Error(m); };
const post = key => fetch(`${GW_URL}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }).then(r => ({ status: r.status, replica: r.headers.get('x-gateway-replica'), retry: r.headers.get('retry-after') }));
try {
  const bad = `urk_${'z'.repeat(43)}`;
  const res = [];
  for (let i = 0; i < Number(LIMIT) * 4; i++) res.push(await post(bad));
  const replicas = new Set(res.map(r => r.replica)).size;
  const unauthorized = res.filter(r => r.status === 401).length, throttled = res.filter(r => r.status === 429);
  must(throttled.length > 0 && throttled.every(r => Number(r.retry) >= 1), `no 429 among ${res.length} bad-key requests`);
  must(unauthorized <= Number(LIMIT) * replicas + 2, `${unauthorized} key lookups answered 401; at most ${LIMIT} per replica expected`);
  // Recovery: once failures stop, a valid key gets through again (a token refills every 2 s).
  const t0 = Date.now(); let ok = false;
  while (!ok && Date.now() - t0 < 30000) { ok = (await post(KEY)).status === 200; if (!ok) await new Promise(r => setTimeout(r, 1000)); }
  must(ok, 'a valid key was still refused 30 s after the flood');
  console.log(`PASS  R: bad-key flood throttled before lookup              ${res.length} requests over ${replicas} replicas: ${unauthorized} answered 401 (key looked up), ${throttled.length} answered 429 (no lookup); a valid key worked again after ${Date.now() - t0} ms`);
  console.log('AUTH SHIELD CHECK PASSED');
} catch (e) {
  console.log(`FAIL  R: bad-key flood throttled before lookup              ${e.message}`);
  console.log('AUTH SHIELD CHECK FAILED'); process.exit(1);
}
