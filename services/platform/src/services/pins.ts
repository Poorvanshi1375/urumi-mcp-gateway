// Tool pinning (stand-out item 6, behind platform.features.toolPinning). Protects against an
// upstream that changes a tool after it was reviewed ("rug pull"): a new description can carry
// instructions aimed at the model, and a new schema can ask for data the tool did not need before.
//   - First sight of a server's tools: all are pinned automatically (trust on first use; the admin
//     just added the server and can see its tools in the dashboard).
//   - Afterwards, a tool whose definition hash differs from its pin, or a new tool, is "pending":
//     hidden from tools/list, refused when called, shown with a diff until an admin approves it.
// Pins are cached in memory and reloaded on NOTIFY 'pins', so every replica agrees.
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tool } from '@modelcontextprotocol/client';
import type { Db } from '../db/client.ts';
import { REGISTRY_CHANNEL } from '../db/client.ts';
import { toolPins } from '../db/schema.ts';

export type ToolDefinition = { title: string | null; description: string; inputSchema: unknown };
type Pin = { hash: string; definition: ToolDefinition };

export const definitionOf = (t: Tool): ToolDefinition => ({ title: t.title ?? null, description: t.description ?? '', inputSchema: t.inputSchema ?? null });

// Key order must not change the hash (Postgres jsonb also reorders keys).
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const toolHash = (t: Tool) => createHash('sha256').update(stable(definitionOf(t))).digest('hex');

export class Pinning {
  readonly enabled: boolean;
  private pins = new Map<string, Map<string, Pin>>();   // upstream id -> tool -> pin
  private db: Db;
  constructor(db: Db, enabled: boolean) { this.db = db; this.enabled = enabled; }

  async load() {
    if (!this.enabled) return;
    const rows = await this.db.select().from(toolPins);
    const next = new Map<string, Map<string, Pin>>();
    for (const r of rows) {
      if (!next.has(r.upstreamId)) next.set(r.upstreamId, new Map());
      next.get(r.upstreamId)!.set(r.tool, { hash: r.hash, definition: r.definition as ToolDefinition });
    }
    this.pins = next;
  }

  // After a successful tools/list: pin everything on first sight, then report what is pending.
  async observe(upstreamId: string, tools: Tool[]): Promise<Set<string>> {
    if (!this.enabled) return new Set();
    if (!this.pins.get(upstreamId)?.size && tools.length) {
      await this.db.insert(toolPins).values(tools.map(t => ({ upstreamId, tool: t.name, hash: toolHash(t), definition: definitionOf(t) })))
        .onConflictDoNothing();
      await this.load();
    }
    return this.pending(upstreamId, tools);
  }

  pending(upstreamId: string, tools: Tool[]): Set<string> {
    if (!this.enabled) return new Set();
    const pins = this.pins.get(upstreamId) ?? new Map<string, Pin>();
    return new Set(tools.filter(t => pins.get(t.name)?.hash !== toolHash(t)).map(t => t.name));
  }

  approved(upstreamId: string, tool: string): ToolDefinition | null {
    return this.pins.get(upstreamId)?.get(tool)?.definition ?? null;
  }

  async approve(upstreamId: string, tool: Tool, by: string | null) {
    const values = { hash: toolHash(tool), definition: definitionOf(tool), approvedAt: new Date(), approvedBy: by };
    await this.db.insert(toolPins).values({ upstreamId, tool: tool.name, ...values })
      .onConflictDoUpdate({ target: [toolPins.upstreamId, toolPins.tool], set: values });
    await this.load();
    await this.db.execute(sql`select pg_notify(${REGISTRY_CHANNEL}, 'pins')`);
  }
}
