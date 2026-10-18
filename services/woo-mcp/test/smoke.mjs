// Smoke test for woo-mcp: every tool, plus validation, Woo-error and auth paths.
// Env: MCP_URL (e.g. http://127.0.0.1:8080/mcp), MCP_BEARER_TOKEN. Exits non-zero on failure.
// The server has no delete tool, so the test product is created as a draft with a TEST- SKU
// (never shown on the storefront); the order whose status is changed is restored afterwards.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const URL_ = process.env.MCP_URL ?? 'http://127.0.0.1:8080/mcp';
const TOKEN = process.env.MCP_BEARER_TOKEN;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(42)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(42)} ${e.message}`); }
}
const json = r => JSON.parse(r.content[0].text);

await check('no token -> 401', async () => {
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  must(r.status === 401, `got ${r.status}`); return `${r.status}`;
});
await check('wrong token -> 401', async () => {
  const r = await fetch(URL_, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  must(r.status === 401, `got ${r.status}`); return `${r.status}`;
});

const client = new Client({ name: 'woo-mcp-smoke', version: '0.0.1' });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
const call = (name, args) => client.callTool({ name, arguments: args });

await check('tools/list', async () => {
  const names = (await client.listTools()).tools.map(t => t.name).sort();
  const want = ['create_product', 'get_order', 'list_orders', 'list_products', 'update_order_status'];
  must(JSON.stringify(names) === JSON.stringify(want), names.join(','));
  return names.join(', ');
});
await check('list_products', async () => {
  const d = json(await call('list_products', { status: 'publish' }));
  must(d.count >= 5, `count ${d.count}`); return `${d.count} published: ${d.products.map(p => p.sku).join(',')}`;
});
await check('list_products search="hoodie"', async () => {
  const d = json(await call('list_products', { search: 'hoodie' }));
  must(d.count === 1 && d.products[0].sku === 'URUMI-HOODIE', JSON.stringify(d)); return `${d.products[0].name} ${d.products[0].price}`;
});
let created;
await check('create_product (draft, TEST- sku)', async () => {
  const r = await call('create_product', { name: 'Smoke Test Product', regular_price: '12.50', sku: `TEST-${Date.now()}`, status: 'draft' });
  must(!r.isError, r.content[0].text); created = json(r);
  return `id=${created.id} ${created.status} ${created.regular_price}`;
});
await check('create_product invalid price -> rejected', async () => {
  const r = await call('create_product', { name: 'Bad', regular_price: 'twelve' }).catch(e => ({ thrown: e.message }));
  must(r.thrown || r.isError, 'accepted an invalid price'); return (r.thrown ?? r.content[0].text).slice(0, 80);
});
let orders;
await check('list_orders', async () => {
  orders = json(await call('list_orders', {}));
  must(orders.count >= 1, `count ${orders.count}`);
  return orders.orders.map(o => `#${o.id} ${o.status} ${o.date_created}`).join(' | ');
});
await check('list_orders created_on=<newest order day>', async () => {
  const day = orders.orders[0].date_created.slice(0, 10);
  const d = json(await call('list_orders', { created_on: day }));
  must(d.count >= 1 && d.orders.every(o => o.date_created.startsWith(day)), JSON.stringify(d).slice(0, 120));
  const none = json(await call('list_orders', { created_on: '2020-01-01' }));
  must(none.count === 0, `2020-01-01 returned ${none.count}`);
  return `${day}: ${d.count} orders; 2020-01-01: 0`;
});
const target = () => orders.orders[orders.orders.length - 1];
await check('get_order', async () => {
  const o = json(await call('get_order', { id: target().id }));
  return `#${o.id} ${o.status} ${o.total} ${o.currency} ${o.customer} items=${o.items.map(i => `${i.quantity}x ${i.name}`).join(',')}`;
});
await check('update_order_status (and restore)', async () => {
  const id = target().id, orig = target().status;
  const a = json(await call('update_order_status', { id, status: 'on-hold' }));
  const b = json(await call('update_order_status', { id, status: orig }));
  must(a.status === 'on-hold' && a.previous_status === orig && b.status === orig, JSON.stringify([a, b]));
  return `${orig} -> on-hold -> ${b.status}`;
});
await check('get_order unknown id -> isError', async () => {
  const r = await call('get_order', { id: 999999 });
  must(r.isError, 'expected isError'); return r.content[0].text;
});
await check('update_order_status bad status -> rejected', async () => {
  const r = await call('update_order_status', { id: target().id, status: 'shipped' }).catch(e => ({ thrown: e.message }));
  must(r.thrown || r.isError, 'accepted an invalid status'); return (r.thrown ?? r.content[0].text).slice(0, 80);
});
await client.close();

console.log(failed ? `WOO-MCP SMOKE FAILED (${failed})` : 'WOO-MCP SMOKE PASSED');
if (created) console.log(`note: draft test product id=${created.id} sku=${created.sku} left in the store (not on the storefront)`);
process.exit(failed ? 1 : 0);
