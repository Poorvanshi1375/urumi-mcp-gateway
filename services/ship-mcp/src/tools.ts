// Shipping tools. Data is simulated and built in (no database). An order id always maps to the same
// carrier and tracking number. Its timeline starts the first time this server is asked about the
// order (always after the order was placed) and advances one stage every SHIP_STAGE_MINUTES, up to a
// final stage fixed per order, so a shipment visibly progresses during a demo. Restarting the server
// starts the timelines again.
// get_order deliberately has the same name as woo-mcp's tool, to exercise the gateway's
// collision handling (requirement G3).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

const CARRIERS = ['Delhivery', 'Blue Dart', 'India Post', 'Ekart'] as const;
const STAGES = ['label_created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered'] as const;
const DAY = 86_400_000;
const STAGE_MS = Number(process.env.SHIP_STAGE_MINUTES ?? 3) * 60_000;
const firstSeen = new Map<number, number>();

// Stable pseudo-random number in [0, 1) from a string.
const unit = (s: string) => createHash('sha256').update(s).digest().readUInt32BE(0) / 2 ** 32;

const CITIES = ['Bengaluru hub', 'Bengaluru sort centre', 'Destination hub', 'Local delivery centre', 'Customer address'];

function shipmentForOrder(orderId: number) {
  const carrier = CARRIERS[Math.floor(unit(`carrier:${orderId}`) * CARRIERS.length)];
  const tracking = `URS${String(orderId).padStart(6, '0')}${carrier.slice(0, 2).toUpperCase()}`;
  if (!firstSeen.has(orderId)) firstSeen.set(orderId, Date.now());
  const start = firstSeen.get(orderId)!;
  // Final stage is fixed per order (at least "picked_up"); progress towards it with time.
  const finalIdx = 1 + Math.floor(unit(`stage:${orderId}`) * (STAGES.length - 1));
  const reached = Math.min(finalIdx, Math.floor((Date.now() - start) / STAGE_MS));
  const events = STAGES.slice(0, reached + 1).map((s, i) => ({ status: s, at: new Date(start + i * STAGE_MS).toISOString(), location: CITIES[i] }));
  const status = STAGES[reached];
  const estimated_delivery = status === 'delivered' ? null : new Date(start + 2 * DAY).toISOString().slice(0, 10);
  return { order_id: orderId, carrier, tracking_number: tracking, status, estimated_delivery, events };
}

function parseTracking(t: string): number | null {
  const m = /^URS(\d{6})([A-Z]{2})$/.exec(t.trim().toUpperCase());
  if (!m) return null;
  const id = Number(m[1]);
  return shipmentForOrder(id).tracking_number === t.trim().toUpperCase() ? id : null;
}

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

export type ToolLogger = (tool: string, ms: number, outcome: 'ok' | 'error', detail?: string) => void;

export function registerShipTools(server: McpServer, opts: { latencyMs: number; log: ToolLogger }) {
  const run = (name: string, fn: (args: any) => unknown) => async (args: any) => {
    const t0 = Date.now();
    if (opts.latencyMs > 0) await new Promise(r => setTimeout(r, opts.latencyMs));
    const result: any = fn(args);
    opts.log(name, Date.now() - t0, result?.isError ? 'error' : 'ok');
    return result;
  };

  server.registerTool('get_order', {
    title: 'Get shipment for an order',
    description: 'Shipping view of a store order: carrier, tracking number, delivery status, events and estimated delivery date. Use the store order id.',
    inputSchema: z.object({ id: z.number().int().min(1).describe('Store order id') }),
    annotations: { readOnlyHint: true },
  }, run('get_order', a => {
    return ok(shipmentForOrder(a.id));
  }));

  server.registerTool('quote_shipping', {
    title: 'Quote shipping',
    // TOOL_DESCRIPTION_SUFFIX is a test knob (like SIMULATED_LATENCY_MS): it changes this tool's
    // definition, the way a compromised upstream would, to exercise the gateway's tool pinning.
    description: `Shipping options and prices (INR) to an Indian PIN code for a parcel weight.${process.env.TOOL_DESCRIPTION_SUFFIX ? ` ${process.env.TOOL_DESCRIPTION_SUFFIX}` : ''}`,
    inputSchema: z.object({
      pincode: z.string().regex(/^[1-9]\d{5}$/, 'a 6-digit Indian PIN code').describe('Destination PIN code'),
      weight_kg: z.number().positive().max(50),
    }),
    annotations: { readOnlyHint: true },
  }, run('quote_shipping', a => {
    const zone = Number(a.pincode[0]) <= 5 ? 'south-west' : 'north-east';
    const slabs = Math.ceil(a.weight_kg / 0.5);
    const local = a.pincode.startsWith('56');
    const standard = (local ? 40 : zone === 'south-west' ? 60 : 80) + 20 * (slabs - 1);
    return ok({
      pincode: a.pincode,
      weight_kg: a.weight_kg,
      zone: local ? 'local' : zone,
      options: [
        { service: 'standard', carrier: 'India Post', price_inr: standard, days: local ? 2 : 5 },
        { service: 'express', carrier: 'Blue Dart', price_inr: Math.round(standard * 1.8), days: local ? 1 : 2 },
      ],
    });
  }));

  server.registerTool('track_shipment', {
    title: 'Track shipment',
    description: 'Tracking events for a tracking number such as URS000016DE (from get_order).',
    inputSchema: z.object({ tracking_number: z.string().min(5).max(40) }),
    annotations: { readOnlyHint: true },
  }, run('track_shipment', a => {
    const id = parseTracking(a.tracking_number);
    if (id === null) return fail(`Unknown tracking number ${a.tracking_number}`);
    return ok(shipmentForOrder(id));
  }));
}
