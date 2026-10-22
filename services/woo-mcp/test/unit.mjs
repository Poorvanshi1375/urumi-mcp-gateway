// Unit checks for woo-mcp that need no store: exact money sums and the list_orders summary.
// Run: node test/unit.mjs   (from services/woo-mcp; CI runs it too)
import { ordersForTotals, registerWooTools, storeDay, sumAmounts, summarizeOrders, TOTALS_CAP } from '../src/tools.ts';

let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(50)} ${fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(50)} ${e.message}`); }
}

check('sumAmounts is exact', () => {
  const cases = [[['145.94', '15.44'], '161.38'], [['0.10', '0.20'], '0.30'], [['100', '50'], '150'], [['-10.00', '25.50'], '15.50'],
    [['1.5', '2.25'], '3.75'], [['-30.00', '10.00'], '-20.00'], [[], '0'], [['0.01', '0.01', '0.01'], '0.03']];
  const bad = cases.filter(([t, want]) => sumAmounts(t) !== want).map(([t, want]) => `${t.join('+')} = ${sumAmounts(t)} (want ${want})`);
  must(!bad.length, bad.join('; '));
  must(0.1 + 0.2 !== 0.3, 'float arithmetic would have been fine?');
  return `${cases.length} cases, incl. 0.10+0.20 = 0.30, refunds and an empty day`;
});
check('sumAmounts refuses anything that is not a decimal', () => {
  for (const t of ['1e3', 'abc', '1.2.3', '']) { let threw = false; try { sumAmounts([t]); } catch { threw = true; } must(threw || t === '', `accepted ${t}`); }
  return '1e3, abc, 1.2.3 refused';
});
check('summary: totals, statuses, completeness', () => {
  const orders = [{ total: '145.94', currency: 'INR', status: 'processing' }, { total: '15.44', currency: 'INR', status: 'on-hold' }, { total: '0.00', currency: 'INR', status: 'cancelled' }];
  const s = summarizeOrders(orders, { 'x-wp-total': '3', 'x-wp-totalpages': '1' }, 1);
  must(s.amount_total === '161.38' && s.currency === 'INR' && s.complete === true && s.total_orders === 3 && s.count_by_status['on-hold'] === 1, JSON.stringify(s));
  const partial = summarizeOrders(orders, { 'x-wp-total': '250', 'x-wp-totalpages': '3' }, 1);
  must(partial.complete === false && partial.total_orders === 250, JSON.stringify(partial));
  const unknown = summarizeOrders(orders, {}, 1);
  must(unknown.complete === null && unknown.total_orders === null, JSON.stringify(unknown));
  return '161.38 INR, complete; page 1 of 3 -> complete false; no headers -> complete null';
});
check('summary: never sums across currencies', () => {
  const s = summarizeOrders([{ total: '10.00', currency: 'INR', status: 'processing' }, { total: '5.00', currency: 'USD', status: 'processing' }, { total: '2.50', currency: 'USD', status: 'completed' }], {}, 1);
  must(s.amount_total === null && s.currency === null && JSON.stringify(s.totals_by_currency) === '[{"currency":"INR","amount_total":"10.00"},{"currency":"USD","amount_total":"7.50"}]', JSON.stringify(s));
  return 'INR 10.00 and USD 7.50 kept apart; no amount_total';
});
check('storeDay resolves today in the store timezone', () => {
  const now = new Date('2026-10-18T20:00:00Z');
  must(storeDay('today', { timezone: 'Asia/Kolkata', utc_offset_hours: 5.5 }, now) === '2026-10-19' && storeDay('today', { timezone: null, utc_offset_hours: -5 }, now) === '2026-10-18', 'wrong day');
  return '20:00 UTC is the 19th in India, the 18th at UTC-5';
});

// A2: totals over every matching order, read 100 per page, capped at 1000.
const fakeWoo = n => ({ get: async (_p, q) => {
  const start = (q.page - 1) * q.per_page;
  const data = Array.from({ length: Math.max(0, Math.min(q.per_page, n - start)) }, (_, i) => ({ id: start + i + 1, total: '1.25', currency: 'INR', status: i % 2 ? 'processing' : 'completed', line_items: [] }));
  return { data, headers: { 'x-wp-total': String(n), 'x-wp-totalpages': String(Math.ceil(n / q.per_page)) } };
} });
for (const [n, want, capped] of [[250, '312.50', false], [1200, '1250.00', true]]) {
  const t = await ordersForTotals(fakeWoo(n), {}, n);
  const first = (await fakeWoo(n).get('orders', { per_page: 20, page: 1 }));
  const s = summarizeOrders(first.data.map(o => ({ ...o })), first.headers, 1, t);
  check(`A2: totals over all pages (${n} orders)`, () => {
    must(s.count === 20 && s.amount_total === want && s.totals_cover === Math.min(n, TOTALS_CAP) && s.totals_capped === capped && s.complete === false, JSON.stringify(s));
    return `page of 20 listed; amount_total ${s.amount_total} over ${s.totals_cover} orders${capped ? ', capped' : ''}`;
  });
}

// AS: results name their store, read once from the WordPress index and cached.
{
  const handlers = {};
  const fakeServer = { registerTool: (name, _cfg, h) => { handlers[name] = h; } };
  let siteReads = 0;
  const woo = {
    siteIndex: async () => { siteReads++; return { name: 'NYC Store', home: 'https://nyc.store.example', timezone_string: 'America/New_York', gmt_offset: -4 }; },
    get: async path => ({
      'data/currencies/current': { data: { code: 'USD', symbol: '&#36;' } },
      products: { data: [{ id: 1, name: 'Mug', sku: 'M', status: 'publish', price: '5', regular_price: '5', stock_status: 'instock' }] },
      orders: { data: [{ id: 7, status: 'processing', total: '5.00', currency: 'USD', date_created: '2026-10-22T10:00:00', billing: { first_name: 'A', last_name: 'B' }, line_items: [] }], headers: { 'x-wp-total': '1', 'x-wp-totalpages': '1' } },
      'orders/7': { data: { id: 7, status: 'processing', total: '5.00', currency: 'USD', date_created: '2026-10-22T10:00:00', billing: { first_name: 'A', last_name: 'B' }, line_items: [] } },
    })[path],
  };
  registerWooTools(fakeServer, woo, () => {});
  const call = async (name, args) => JSON.parse((await handlers[name](args)).content[0].text);
  const lo = await call('list_orders', { status: 'any', page: 1 }), go = await call('get_order', { id: 7 }), lp = await call('list_products', { status: 'any', per_page: 10, page: 1 });
  check('AS: results name their store', () => {
    const want = JSON.stringify({ title: 'NYC Store', url: 'https://nyc.store.example' });
    must([lo, go, lp].every(r => JSON.stringify(r.store) === want), JSON.stringify([lo.store, go.store, lp.store]));
    must(Object.keys(lo).indexOf('amount_total') < Object.keys(lo).indexOf('store') && Object.keys(lo).at(-1) === 'orders', `list_orders keys: ${Object.keys(lo)}`);
    must(go.id === 7 && lp.count === 1 && siteReads === 1, `id ${go.id}, count ${lp.count}, site read ${siteReads} times`);
    return 'list_orders, get_order, list_products carry store {title, url}; totals still first; the site index read once (cached)';
  });
}

console.log(failed ? `WOO-MCP UNIT FAILED (${failed})` : 'WOO-MCP UNIT PASSED');
process.exit(failed ? 1 : 0);
