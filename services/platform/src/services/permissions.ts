// Tool permissions by role (stand-out item 2). Admins may use every tool. For members, a tool is
// allowed unless a rule says otherwise: an exact rule for (server, tool) wins over the server-wide
// rule (tool '*'). Rules are cached in memory and reloaded when any process NOTIFYs a change, so
// the check on every list and call costs no query.
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { REGISTRY_CHANNEL } from '../db/client.ts';
import { toolPermissions } from '../db/schema.ts';

export type Rule = typeof toolPermissions.$inferSelect;
export type Role = 'admin' | 'member';
export const ALL_TOOLS = '*';

export class Permissions {
  private rules = new Map<string, boolean>();   // "<prefix>\n<tool>" -> allowed, for members
  private db: Db;
  constructor(db: Db) { this.db = db; }

  async load() {
    const rows = await this.db.select().from(toolPermissions).where(eq(toolPermissions.role, 'member'));
    this.rules = new Map(rows.map(r => [`${r.serverPrefix}\n${r.tool}`, r.allowed]));
  }

  allows(role: Role | undefined, prefix: string, tool: string): boolean {
    if (role === 'admin') return true;
    return this.rules.get(`${prefix}\n${tool}`) ?? this.rules.get(`${prefix}\n${ALL_TOOLS}`) ?? true;
  }
}

export const listRules = (db: Db) => db.select().from(toolPermissions).orderBy(toolPermissions.serverPrefix, toolPermissions.tool);

// Set one member rule. A rule that matches the default (allowed, with no server-wide rule to
// override) is deleted rather than stored, so the table only holds real restrictions.
export async function setMemberRule(db: Db, prefix: string, tool: string, allowed: boolean, by: string | null) {
  const serverWide = tool !== ALL_TOOLS && (await db.select().from(toolPermissions)
    .where(and(eq(toolPermissions.role, 'member'), eq(toolPermissions.serverPrefix, prefix), eq(toolPermissions.tool, ALL_TOOLS))))[0];
  if (allowed && (!serverWide || serverWide.allowed)) {
    await db.delete(toolPermissions).where(and(eq(toolPermissions.role, 'member'), eq(toolPermissions.serverPrefix, prefix), eq(toolPermissions.tool, tool)));
  } else {
    await db.insert(toolPermissions).values({ role: 'member', serverPrefix: prefix, tool, allowed, updatedBy: by })
      .onConflictDoUpdate({ target: [toolPermissions.role, toolPermissions.serverPrefix, toolPermissions.tool], set: { allowed, updatedBy: by, updatedAt: new Date() } });
  }
  await db.execute(sql`select pg_notify(${REGISTRY_CHANNEL}, 'permissions')`);
}

// Keep rules in step with the registry: a removed server's rules go, a renamed prefix moves them.
export async function deleteServerRules(db: Db, prefix: string) {
  await db.delete(toolPermissions).where(eq(toolPermissions.serverPrefix, prefix));
}
export async function renameServerRules(db: Db, from: string, to: string) {
  await db.update(toolPermissions).set({ serverPrefix: to }).where(eq(toolPermissions.serverPrefix, from));
}
