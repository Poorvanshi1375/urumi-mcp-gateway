// G4/D8: a dead or slow upstream must not break the others. Breaks the "ship" upstream with
// $BREAK_CMD, checks the gateway, then restores it with $FIX_CMD.
// Env: GW_URL, KEY_ADMIN, BREAK_CMD, FIX_CMD, MODE = dead | slow
import { execSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { GW_URL, KEY_ADMIN, BREAK_CMD, FIX_CMD, MODE = 'dead' } = process.env;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(44)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(44)} ${e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = r => r.content.map(c => c.text ?? '').join(' ');
const status = async () => (await (await fetch(`${GW_URL}/api/status`, { headers: { authorization: `Bearer ${KEY_ADMIN}` } })).json()).upstreams;
const shipStatus = async () => (await status()).find(u => u.prefix === 'ship');
async function waitFor(fn, ms) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(500); } }
const timed = async p => { const t0 = Date.now(); const v = await p; return [v, Date.now() - t0]; };

const c = new Client({ name: 'isolation-check', version: '0.0.1' });
await c.connect(new StreamableHTTPClientTransport(new URL(`${GW_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${KEY_ADMIN}` } } }));
const list = () => c.listTools(undefined, { cacheMode: 'bypass' }).then(r => r.tools.map(t => t.name));
// Any existing order (the store may be fresh): the newest one.
const orderId = JSON.parse(text(await c.callTool({ name: 'woo__list_orders', arguments: { per_page: 1 } }))).orders[0]?.id ?? 1;

console.log(`mode=${MODE}; breaking ship: ${BREAK_CMD}`);
execSync(BREAK_CMD, { stdio: 'inherit' });
try {
  if (MODE === 'dead') {
    await check('dashboard status shows ship Unreachable (G7, D8)', async () => {
      const s = await waitFor(async () => { const s = await shipStatus(); return s.status === 'unreachable' && s; }, 60000);
      must(s, `still ${(await shipStatus()).status}`); return `unreachable: ${s.error}`;
    });
    await check('tools/list stays fast, without ship', async () => {
      const runs = []; let names;
      for (let i = 0; i < 5; i++) { const [n, ms] = await timed(list()); runs.push(ms); names = n; }
      must(!names.some(n => n.startsWith('ship__')) && names.some(n => n.startsWith('woo__')), names.join(','));
      return `${names.length} tools, list took ${runs.join('/')} ms`;
    });
    await check('ship call -> clear error, not a hang', async () => {
      const [r, ms] = await timed(c.callTool({ name: 'ship__get_order', arguments: { id: 16 } }));
      must(r.isError, 'expected isError'); return `${ms} ms: ${text(r)}`;
    });
  } else {
    await check('slow ship call times out with a clear error', async () => {
      const [r, ms] = await timed(c.callTool({ name: 'ship__get_order', arguments: { id: 16 } }));
      must(r.isError && /did not answer/.test(text(r)), text(r)); return `${ms} ms: ${text(r)}`;
    });
    await check('woo call during a slow ship call is not delayed', async () => {
      const slow = c.callTool({ name: 'ship__get_order', arguments: { id: 17 } });
      await sleep(200);
      const [r, ms] = await timed(c.callTool({ name: 'woo__list_orders', arguments: { per_page: 1 } }));
      await slow;
      must(!r.isError && ms < 3000, `${ms} ms ${text(r).slice(0, 80)}`); return `woo answered in ${ms} ms while ship was hanging`;
    });
  }
  await check('other upstreams keep working', async () => {
    const [r, ms] = await timed(c.callTool({ name: 'woo__get_order', arguments: { id: orderId } }));
    must(!r.isError, text(r)); return `woo__get_order ${orderId} in ${ms} ms`;
  });
} finally {
  console.log(`restoring ship: ${FIX_CMD}`);
  execSync(FIX_CMD, { stdio: 'inherit' });
}
if (MODE === 'dead') {
  await check('ship recovers to Connected, tools return', async () => {
    const s = await waitFor(async () => { const s = await shipStatus(); return s.status === 'connected' && s; }, 90000);
    must(s, `still ${(await shipStatus()).status}`);
    const names = await waitFor(async () => { const n = await list(); return n.some(x => x.startsWith('ship__')) && n; }, 15000);
    must(names, 'ship tools not listed'); return `connected, ${names.filter(n => n.startsWith('ship__')).length} ship tools`;
  });
}
await c.close();
console.log(failed ? `ISOLATION CHECK (${MODE}) FAILED (${failed})` : `ISOLATION CHECK (${MODE}) PASSED`);
process.exit(failed ? 1 : 0);
