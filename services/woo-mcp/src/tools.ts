// The five WooCommerce tools (requirement W3). Each returns compact JSON text; Woo failures
// come back as isError results with a readable message rather than protocol errors.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { describeWooError, type WooApi } from './woo.ts';

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
  email: o.billing?.email || null,
  items: (o.line_items ?? []).map((i: any) => ({ product_id: i.product_id, name: i.name, quantity: i.quantity, total: i.total })),
});

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

export type ToolLogger = (tool: string, ms: number, outcome: 'ok' | 'error', detail?: string) => void;

export function registerWooTools(server: McpServer, woo: WooApi, log: ToolLogger) {
  // Wrap a handler: time it, log it, and turn Woo exceptions into isError results.
  const run = (name: string, fn: (args: any) => Promise<unknown>) => async (args: any) => {
    const t0 = Date.now();
    try {
      const result = await fn(args);
      log(name, Date.now() - t0, 'ok');
      return ok(result);
    } catch (err) {
      const msg = describeWooError(err);
      log(name, Date.now() - t0, 'error', msg);
      return fail(msg);
    }
  };

  server.registerTool('list_products', {
    title: 'List products',
    description: 'List or search WooCommerce products. Returns id, name, SKU, status, prices and stock.',
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
    return { count: r.data.length, products: r.data.map(product) };
  }));

  server.registerTool('create_product', {
    title: 'Create product',
    description: 'Create a simple WooCommerce product. Published products appear on the storefront immediately.',
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
    const r = await woo.post('products', body);
    return product(r.data);
  }));

  server.registerTool('list_orders', {
    title: 'List orders',
    description: 'List WooCommerce orders, newest first. Filter by status, by one calendar day in the store timezone (created_on), or by a date range.',
    inputSchema: z.object({
      status: z.enum(['any', ...ORDER_STATUSES]).default('any'),
      created_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only orders created on this day (YYYY-MM-DD, store timezone), e.g. today'),
      after: z.string().optional().describe('Only orders created after this ISO 8601 date-time (store timezone)'),
      before: z.string().optional().describe('Only orders created before this ISO 8601 date-time (store timezone)'),
      search: z.string().min(1).optional().describe('Search customer name, email or address'),
      per_page: z.number().int().min(1).max(50).default(20),
      page: z.number().int().min(1).default(1),
    }),
    annotations: { readOnlyHint: true },
  }, run('list_orders', async a => {
    const after = a.created_on ? `${a.created_on}T00:00:00` : a.after;
    const before = a.created_on ? `${a.created_on}T23:59:59` : a.before;
    const r = await woo.get('orders', { status: a.status, after, before, search: a.search, per_page: a.per_page, page: a.page, orderby: 'date', order: 'desc' });
    return { count: r.data.length, orders: r.data.map(order) };
  }));

  server.registerTool('get_order', {
    title: 'Get order',
    description: 'Get one WooCommerce order by id, with its line items, customer and totals.',
    inputSchema: z.object({ id: z.number().int().min(1) }),
    annotations: { readOnlyHint: true },
  }, run('get_order', async a => order((await woo.get(`orders/${a.id}`)).data)));

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
