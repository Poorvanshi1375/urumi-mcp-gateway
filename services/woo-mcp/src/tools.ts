// The WooCommerce tools: the five of requirement W3 plus get_store_info. Each returns compact JSON
// text; Woo failures come back as isError results with a readable message rather than protocol errors.
// Fields are chosen by name: customer contact details (email, phone, street address) never leave
// this server, so neither the language model nor an external client receives them.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { describeWooError, ToolError, type WooApi } from './woo.ts';

export const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as const;

const product = (p: any) => ({
  id: p.id,
  name: p.name,
  sku: p.sku || null,
  status: p.status,
  price: p.price,
  regular_price: p.regular_price,
  stock_status: p.stock_status,
  stock_quantity: p.stock_quantity,
  permalink: p.permalink,
});

const order = (o: any) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  date_created: o.date_created,
  date_created_gmt: o.date_created_gmt,
  total: o.total,
  currency: o.currency,
  payment_method: o.payment_method_title || o.payment_method,
  customer: [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(' ') || null,
  items: (o.line_items ?? []).map((i: any) => ({ product_id: i.product_id, name: i.name, quantity: i.quantity, total: i.total })),
});

// Store settings that decide what "today" means and which currency prices are in. Read once and kept
// for 10 minutes: the timezone from the public WordPress index, the currency from WooCommerce.
const STORE_INFO_TTL_MS = 10 * 60_000;
type StoreInfo = { name: string | null; url: string | null; timezone: string | null; utc_offset_hours: number; currency: string | null; currency_symbol: string | null };
function storeInfoReader(woo: WooApi) {
  let cached: { at: number; info: StoreInfo } | undefined;
  return async (): Promise<StoreInfo> => {
    if (cached && Date.now() - cached.at < STORE_INFO_TTL_MS) return cached.info;
    const [site, cur] = await Promise.all([woo.siteIndex(), woo.get('data/currencies/current').then(r => r.data)]);
    const info = { name: site.name ?? null, url: site.home || site.url || null, timezone: site.timezone_string || null, utc_offset_hours: Number(site.gmt_offset ?? 0),
      currency: cur?.code ?? null, currency_symbol: cur?.symbol ? decodeEntities(cur.symbol) : null };
    cached = { at: Date.now(), info };
    return info;
  };
}
const decodeEntities = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');

// A calendar day in the store's timezone: "today", "yesterday" or a YYYY-MM-DD date as given.
// Stores set to a UTC offset instead of a city have no timezone name; the offset is used then.
export function storeDay(day: string, info: Pick<StoreInfo, 'timezone' | 'utc_offset_hours'>, now = new Date()): string {
  if (day !== 'today' && day !== 'yesterday') return day;
  const t = new Date(now.getTime() - (day === 'yesterday' ? 86_400_000 : 0));
  if (info.timezone) return t.toLocaleDateString('en-CA', { timeZone: info.timezone });
  return new Date(t.getTime() + info.utc_offset_hours * 3_600_000).toISOString().slice(0, 10);
}

// Order totals are computed here, never by the language model: models add decimals unreliably,
// and "what came in today" must state the right amount. Amounts are WooCommerce decimal strings;
// they are summed as integers of minor units (BigInt), using the longest fraction in the list, so
// 0.10 + 0.20 is exactly 0.30. Negative amounts (refunds as orders) work.
export function sumAmounts(totals: string[]): string {
  const parsed = totals.map(t => {
    const m = /^(-)?(\d*)(?:\.(\d+))?$/.exec(String(t).trim());
    if (!m) throw new Error(`not a decimal amount: ${t}`);
    return { neg: Boolean(m[1]), int: m[2] || '0', frac: m[3] ?? '' };
  });
  const scale = Math.max(0, ...parsed.map(p => p.frac.length));
  let sum = 0n;
  for (const p of parsed) {
    const v = BigInt(p.int + p.frac.padEnd(scale, '0'));
    sum += p.neg ? -v : v;
  }
  const neg = sum < 0n;
  const digits = (neg ? -sum : sum).toString().padStart(scale + 1, '0');
  const out = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return neg ? `-${out}` : out;
}

// The summary that comes first in list_orders (before the orders, so it survives truncation).
// Totals never mix currencies; completeness comes from WooCommerce's X-WP-Total headers and is
// null when they are missing, rather than claimed.
// The totals cover every matching order, not just the page returned (idea A2): when there is more
// than one page, the other pages are read too, 100 at a time, up to TOTALS_CAP orders; past that
// the summary says the totals are capped.
export const TOTALS_CAP = 1000;
export async function ordersForTotals(woo: WooApi, params: Record<string, unknown>, totalOrders: number | null) {
  const orders: any[] = [];
  for (let page = 1; orders.length < TOTALS_CAP; page++) {
    const r = await woo.get('orders', { ...params, per_page: 100, page });
    orders.push(...r.data.map(order));
    if (r.data.length < 100) break;
  }
  return { orders: orders.slice(0, TOTALS_CAP), capped: (totalOrders ?? orders.length) > TOTALS_CAP };
}

export function summarizeOrders(pageOrders: any[], headers: Record<string, unknown> | undefined, page: number, totals?: { orders: any[]; capped: boolean }) {
  const orders = totals?.orders ?? pageOrders;
  const num = (v: unknown) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const totalOrders = num(headers?.['x-wp-total']);
  const totalPages = num(headers?.['x-wp-totalpages']);
  const byCurrency = new Map<string, string[]>();
  for (const o of orders) byCurrency.set(o.currency ?? '', [...(byCurrency.get(o.currency ?? '') ?? []), o.total ?? '0']);
  const countByStatus: Record<string, number> = {};
  for (const o of orders) countByStatus[o.status] = (countByStatus[o.status] ?? 0) + 1;
  const single = byCurrency.size <= 1;
  return {
    count: pageOrders.length,
    total_orders: totalOrders,
    page,
    total_pages: totalPages,
    complete: totalPages === null ? null : page >= totalPages,
    amount_total: single ? sumAmounts([...byCurrency.values()][0] ?? []) : null,
    currency: single ? ([...byCurrency.keys()][0] || null) : null,
    totals_by_currency: single ? null : [...byCurrency].map(([currency, t]) => ({ currency, amount_total: sumAmounts(t) })),
    count_by_status: countByStatus,
    totals_cover: orders.length,          // orders the amounts and statuses above were computed over
    totals_capped: totals?.capped ?? false,
  };
}

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

export type ToolLogger = (tool: string, ms: number, outcome: 'ok' | 'error', detail?: string, requestId?: string) => void;
// The gateway's request id, from the W3C trace context it sends in _meta (traceparent), so one call
// can be followed through the gateway's audit row and this server's log.
export const requestIdOf = (ctx: any): string | undefined => /^00-([0-9a-f]{32})-/.exec(ctx?.mcpReq?._meta?.traceparent ?? '')?.[1];


export function registerWooTools(server: McpServer, woo: WooApi, log: ToolLogger) {
  const storeInfo = storeInfoReader(woo);
  // Which store a result came from (AS): with several stores connected, a model comparing them must
  // never mix up whose orders or products it is reading. From the cached store info.
  const store = async () => { const i = await storeInfo(); return { title: i.name, url: i.url }; };
  // Wrap a handler: time it, log it, and turn Woo exceptions into isError results.
  const run = (name: string, fn: (args: any) => Promise<unknown>) => async (args: any, ctx?: unknown) => {
    const t0 = Date.now();
    const requestId = requestIdOf(ctx);
    try {
      const result = await fn(args);
      log(name, Date.now() - t0, 'ok', undefined, requestId);
      return ok(result);
    } catch (err) {
      const msg = describeWooError(err);
      log(name, Date.now() - t0, 'error', msg, requestId);
      return fail(msg);
    }
  };

  server.registerTool('list_products', {
    title: 'List products',
    description: 'List or search WooCommerce products. Returns id, name, SKU, status, prices and stock, and the store they are from (store.title, store.url).',
    inputSchema: z.object({
      search: z.string().min(1).optional().describe('Text to search for in product names and descriptions'),
      sku: z.string().min(1).optional().describe('Exact SKU'),
      status: z.enum(['any', 'publish', 'draft', 'pending', 'private']).default('any'),
      per_page: z.number().int().min(1).max(50).default(10),
      page: z.number().int().min(1).default(1),
    }),
    annotations: { readOnlyHint: true },
  }, run('list_products', async a => {
    const r = await woo.get('products', { search: a.search, sku: a.sku, status: a.status, per_page: a.per_page, page: a.page, orderby: 'date', order: 'desc' });
    return { store: await store(), count: r.data.length, products: r.data.map(product) };
  }));

  server.registerTool('create_product', {
    title: 'Create product',
    description: 'Create a simple WooCommerce product. Published products appear on the storefront immediately. Pass a sku when the call might be repeated (for example after a timeout): a second call with the same sku, name and price returns the existing product (already_existed: true) instead of creating a duplicate.',
    inputSchema: z.object({
      name: z.string().min(1).max(200),
      regular_price: z.string().regex(/^\d+(\.\d{1,2})?$/, 'a decimal amount such as "499" or "19.99"').describe('Price in the store currency, as a decimal string'),
      description: z.string().max(5000).optional(),
      sku: z.string().min(1).max(100).optional(),
      status: z.enum(['publish', 'draft']).default('publish'),
      stock_quantity: z.number().int().min(0).optional().describe('If set, stock is managed with this quantity'),
    }),
  }, run('create_product', async a => {
    const body: Record<string, unknown> = { type: 'simple', name: a.name, regular_price: a.regular_price, status: a.status };
    if (a.description) body.description = a.description;
    if (a.sku) body.sku = a.sku;
    if (a.stock_quantity !== undefined) Object.assign(body, { manage_stock: true, stock_quantity: a.stock_quantity });
    try {
      return product((await woo.post('products', body)).data);
    } catch (err: any) {
      // WooCommerce enforces unique SKUs. A repeat of the same request returns the product it made;
      // a different product under that SKU is a conflict, not a success.
      if (!a.sku || err?.response?.data?.code !== 'product_invalid_sku') throw err;
      const existing = (await woo.get('products', { sku: a.sku, status: 'any' })).data?.[0];
      if (!existing) throw err;
      if (existing.name === a.name && Number(existing.regular_price) === Number(a.regular_price)) return { ...product(existing), already_existed: true };
      throw new ToolError(`SKU ${a.sku} is already used by product #${existing.id} ("${existing.name}", price ${existing.regular_price}); use another sku`);
    }
  }));

  server.registerTool('list_orders', {
    title: 'List orders',
    description: 'List WooCommerce orders, newest first. Filter by status, by one calendar day in the store timezone (created_on: "today", "yesterday" or YYYY-MM-DD), or by a date range. Returns count, total_orders, amount_total and count_by_status first, computed exactly by the store over every matching order (up to 1000; totals_capped says when more): use them instead of adding up amounts yourself. When complete is false, only the orders of this page are listed; the totals still cover all of them. store names the store (title, url). Results carry the customer name but no contact details.',
    inputSchema: z.object({
      status: z.enum(['any', ...ORDER_STATUSES]).default('any'),
      created_on: z.string().regex(/^(today|yesterday|\d{4}-\d{2}-\d{2})$/, '"today", "yesterday" or YYYY-MM-DD').optional()
        .describe('Only orders created on this day in the store timezone: "today", "yesterday" or YYYY-MM-DD'),
      after: z.string().optional().describe('Only orders created after this ISO 8601 date-time (store timezone)'),
      before: z.string().optional().describe('Only orders created before this ISO 8601 date-time (store timezone)'),
      search: z.string().min(1).optional().describe('Search customer name, email or address (results never include contact details)'),
      per_page: z.number().int().min(1).max(100).optional().describe('Orders per page (default 20; 100 when created_on is given, so a whole day fits in one page)'),
      page: z.number().int().min(1).default(1),
    }),
    annotations: { readOnlyHint: true },
  }, run('list_orders', async a => {
    // WooCommerce reads after/before without an offset in the store's timezone, so a day maps directly.
    const day = a.created_on ? storeDay(a.created_on, await storeInfo()) : undefined;
    const after = day ? `${day}T00:00:00` : a.after;
    const before = day ? `${day}T23:59:59` : a.before;
    const perPage = a.per_page ?? (a.created_on ? 100 : 20);
    const filter = { status: a.status, after, before, search: a.search, orderby: 'date', order: 'desc' };
    const r = await woo.get('orders', { ...filter, per_page: perPage, page: a.page });
    const orders = r.data.map(order);
    const totalPages = Number(r.headers?.['x-wp-totalpages'] ?? 1);
    // One page holds everything: its totals are the totals. Otherwise read every page for them.
    const totals = totalPages > 1 ? await ordersForTotals(woo, filter, Number(r.headers?.['x-wp-total'] ?? NaN) || null) : undefined;
    return { ...(day ? { created_on: day } : {}), ...summarizeOrders(orders, r.headers, a.page, totals), store: await store(), orders };
  }));

  server.registerTool('get_store_info', {
    title: 'Get store info',
    description: 'The store\'s name, address, timezone, current date and currency. Use it to know what "today" means for the store and which currency prices are in.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, run('get_store_info', async () => {
    const info = await storeInfo();
    return { ...info, today: storeDay('today', info) };
  }));

  server.registerTool('get_order', {
    title: 'Get order',
    description: 'Get one WooCommerce order by id, with its line items, customer and totals, and the store it is from (store.title, store.url).',
    inputSchema: z.object({ id: z.number().int().min(1) }),
    annotations: { readOnlyHint: true },
  }, run('get_order', async a => ({ store: await store(), ...order((await woo.get(`orders/${a.id}`)).data) })));

  server.registerTool('update_order_status', {
    title: 'Update order status',
    description: `Change an order's status. Allowed: ${ORDER_STATUSES.join(', ')}.`,
    inputSchema: z.object({ id: z.number().int().min(1), status: z.enum(ORDER_STATUSES) }),
    annotations: { idempotentHint: true },
  }, run('update_order_status', async a => {
    const before = (await woo.get(`orders/${a.id}`)).data.status;
    const r = await woo.put(`orders/${a.id}`, { status: a.status });
    return { id: r.data.id, previous_status: before, status: r.data.status };
  }));
}
