// Smoke test for ship-mcp. Env: MCP_URL (e.g. http://127.0.0.1:8080/mcp), MCP_BEARER_TOKEN.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const URL_ = process.env.MCP_URL ?? 'http://127.0.0.1:8080/mcp';
const TOKEN = process.env.MCP_BEARER_TOKEN;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(40)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(40)} ${e.message}`); }
}
const json = r => JSON.parse(r.content[0].text);
const post = headers => fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });

await check('no token -> 401', async () => { const r = await post({}); must(r.status === 401, `${r.status}`); return `${r.status}`; });
await check('wrong token -> 401', async () => { const r = await post({ authorization: 'Bearer nope' }); must(r.status === 401, `${r.status}`); return `${r.status}`; });

const client = new Client({ name: 'ship-mcp-smoke', version: '0.0.1' });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
const call = (name, args) => client.callTool({ name, arguments: args });

await check('tools/list', async () => {
  const names = (await client.listTools()).tools.map(t => t.name).sort();
  must(JSON.stringify(names) === '["get_order","quote_shipping","track_shipment"]', names.join(','));
  return names.join(', ');
});
let s16;
await check('get_order 16 (collides with woo get_order)', async () => {
  s16 = json(await call('get_order', { id: 16 }));
  must(s16.order_id === 16 && /^URS000016[A-Z]{2}$/.test(s16.tracking_number), JSON.stringify(s16));
  return `${s16.carrier} ${s16.tracking_number} ${s16.status} events=${s16.events.length}`;
});
await check('get_order is deterministic', async () => {
  const again = json(await call('get_order', { id: 16 }));
  must(again.tracking_number === s16.tracking_number && again.carrier === s16.carrier && again.events[0].at === s16.events[0].at, 'differs between calls');
  return 'same carrier, tracking and start time';
});
await check('track_shipment (from get_order)', async () => {
  const t = json(await call('track_shipment', { tracking_number: s16.tracking_number }));
  must(t.order_id === 16 && t.status === s16.status, JSON.stringify(t)); return `${t.tracking_number} -> order ${t.order_id}, ${t.events.length} events`;
});
await check('track_shipment unknown -> isError', async () => {
  const r = await call('track_shipment', { tracking_number: 'URS000016ZZ' });
  must(r.isError, 'expected isError'); return r.content[0].text;
});
await check('quote_shipping Bengaluru 1.2 kg', async () => {
  const q = json(await call('quote_shipping', { pincode: '560001', weight_kg: 1.2 }));
  must(q.zone === 'local' && q.options.length === 2, JSON.stringify(q));
  return q.options.map(o => `${o.service} ₹${o.price_inr} ${o.days}d`).join(', ');
});
await check('quote_shipping bad pincode -> rejected', async () => {
  const r = await call('quote_shipping', { pincode: '12345', weight_kg: 1 }).catch(e => ({ thrown: e.message }));
  must(r.thrown || r.isError, 'accepted a 5-digit pincode'); return (r.thrown ?? r.content[0].text).slice(0, 70);
});
await client.close();
console.log(failed ? `SHIP-MCP SMOKE FAILED (${failed})` : 'SHIP-MCP SMOKE PASSED');
process.exit(failed ? 1 : 0);
