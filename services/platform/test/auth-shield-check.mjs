// Idea R, against the running gateway: an address that keeps failing /mcp authentication gets 429
// before any key lookup, and a valid key works again once the failures stop. Run last by
// verify-dod.sh: locally every request comes from k3d's load balancer, so the flood briefly
// throttles everything from this machine. Env: GW_URL, KEY (a valid API key), LIMIT (per minute).
import http2 from 'node:http2';
import { Agent, fetch } from 'undici';
const { GW_URL, KEY, LIMIT = '30' } = process.env;
const must = (c, m) => { if (!c) throw new Error(m); };
// One connection, so the flood comes from one address (a mobile or CGNAT network may send each new
// connection from another one, and each address has its own budget); the proxy still spreads the
// requests over the replicas. Over https it is one HTTP/2 session, so a wave of requests goes out at
// once: sent one by one over a slow link (India to Sydney, 0.45 s), each replica's budget refills
// about as fast as it is spent. (undici's allowH2 still sent them one at a time.)
const WAVE = 20;
const BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const headers = key => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
const h2 = GW_URL.startsWith('https:') ? http2.connect(GW_URL) : null;
const one = new Agent({ connections: 1 });
const post = key => h2
  ? new Promise((resolve, reject) => {
    const r = h2.request({ ':method': 'POST', ':path': new URL('/mcp', GW_URL).pathname, ...headers(key) });
    r.on('response', h => { r.resume(); r.on('end', () => resolve({ status: h[':status'], replica: h['x-gateway-replica'], retry: h['retry-after'] })); });
    r.on('error', reject);
    r.end(BODY);
  })
  : fetch(`${GW_URL}/mcp`, { dispatcher: one, method: 'POST', headers: headers(key), body: BODY })
    .then(r => ({ status: r.status, replica: r.headers.get('x-gateway-replica'), retry: r.headers.get('retry-after') }));
try {
  const bad = `urk_${'z'.repeat(43)}`;
  const res = [];
  const t0flood = Date.now();
  // Each replica has its own shield (LIMIT failures per address), so send until the first 429,
  // however many replicas there are (2 on k3d, up to 4 on the VPS).
  while (res.length < Number(LIMIT) * 10 && !res.some(r => r.status === 429)) res.push(...await Promise.all(Array.from({ length: WAVE }, () => post(bad))));
  const replicas = new Set(res.map(r => r.replica)).size;
  const unauthorized = res.filter(r => r.status === 401).length, throttled = res.filter(r => r.status === 429);
  must(throttled.length > 0 && throttled.every(r => Number(r.retry) >= 1), `no 429 among ${res.length} bad-key requests`);
  // A token bucket allows its burst plus what refilled meanwhile (LIMIT per minute), per replica. The
  // gateway checks the budget before the lookup and charges it after a failure (so a busy valid client
  // is never refused), so requests in flight together may each pass: at most one wave more.
  const minutes = (Date.now() - t0flood) / 60000;
  const allowed = Math.floor(replicas * Number(LIMIT) * (1 + minutes)) + WAVE;
  must(unauthorized <= allowed, `${unauthorized} key lookups answered 401 in ${Math.round(minutes * 60)} s; at most ${allowed} expected (${LIMIT} per replica plus refill, plus one wave in flight)`);
  // Recovery: once failures stop, a valid key gets through again (a token refills every 2 s).
  const t0 = Date.now(); let ok = false;
  while (!ok && Date.now() - t0 < 30000) { ok = (await post(KEY)).status === 200; if (!ok) await new Promise(r => setTimeout(r, 1000)); }
  must(ok, 'a valid key was still refused 30 s after the flood');
  console.log(`PASS  R: bad-key flood throttled before lookup              ${res.length} requests over ${replicas} replicas: ${unauthorized} answered 401 (key looked up), ${throttled.length} answered 429 (no lookup); a valid key worked again after ${Date.now() - t0} ms`);
  console.log('AUTH SHIELD CHECK PASSED');
  h2?.close();
} catch (e) {
  console.log(`FAIL  R: bad-key flood throttled before lookup              ${e.message}`);
  console.log('AUTH SHIELD CHECK FAILED'); h2?.close(); process.exit(1);
}
