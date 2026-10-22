// Tool permissions by role (stand-out item 2). Admins may use every tool. For members, an exact
// rule for (server, tool) wins over the server-wide rule (tool '*'), and with no rule the member
// default decides (platform.permissions.memberDefault):
//   allow     every tool;
//   readOnly  only tools the server marks readOnlyHint: true, and only if the gateway trusts that
//             server's annotations (the release's own servers, or an admin marked it; M). A server
//             an admin adds later is then safe by default: its tools are admin-only until someone
//             allows them or vouches for its hints. Changing the hint needs re-approval under tool
//             pinning, so an upstream cannot widen itself later either.
// Rules are cached in memory and reloaded when any process NOTIFYs a change, so the check on every
// list and call costs no query.
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { REGISTRY_CHANNEL } from '../db/client.ts';
import { toolConfirmRules, toolPermissions } from '../db/schema.ts';

export type Rule = typeof toolPermissions.$inferSelect;
export type Role = 'admin' | 'member';
export const ALL_TOOLS = '*';
export type MemberDefault = 'allow' | 'readOnly';
export type ConfirmMode = 'auto' | 'always' | 'never';
export const isReadOnly = (t: { annotations?: unknown } | undefined) => (t?.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint === true;

// Whether chat asks before running a tool (C): an admin's 'always' or 'never' wins; otherwise it
// asks unless the tool is read-only by the hint of a server whose hints are trusted (M). Fail-closed:
// a tool with no annotations counts as a write.
export const asksInChat = (mode: ConfirmMode, trustedReadOnly: boolean) => mode === 'always' || (mode === 'auto' && !trustedReadOnly);

export class Permissions {
  private rules = new Map<string, boolean>();   // "<prefix>\n<tool>" -> allowed, for members
  private confirmRules = new Map<string, ConfirmMode>();   // "<prefix>\n<tool>" -> chat confirmation override (C)
  private db: Db;
  readonly memberDefault: MemberDefault;
  constructor(db: Db, memberDefault: MemberDefault = 'allow') { this.db = db; this.memberDefault = memberDefault; }

  async load() {
    const rows = await this.db.select().from(toolPermissions).where(eq(toolPermissions.role, 'member'));
    this.rules = new Map(rows.map(r => [`${r.serverPrefix}\n${r.tool}`, r.allowed]));
    const confirm = await this.db.select().from(toolConfirmRules);
    this.confirmRules = new Map(confirm.map(r => [`${r.serverPrefix}\n${r.tool}`, r.mode as ConfirmMode]));
  }

  // The admin's override of when chat asks before running a tool: the exact rule, else the
  // server-wide one, else automatic.
  confirmMode(prefix: string, tool: string): ConfirmMode {
    return this.confirmRules.get(`${prefix}\n${tool}`) ?? this.confirmRules.get(`${prefix}\n${ALL_TOOLS}`) ?? 'auto';
  }

  // readOnly: the tool's readOnlyHint, from a trusted server (only used when no rule applies).
  allows(role: Role | undefined, prefix: string, tool: string, readOnly = false): boolean {
    if (role === 'admin') return true;
    return this.rules.get(`${prefix}\n${tool}`) ?? this.rules.get(`${prefix}\n${ALL_TOOLS}`) ?? (this.memberDefault === 'allow' || readOnly);
  }
}

export const listRules = (db: Db) => db.select().from(toolPermissions).orderBy(toolPermissions.serverPrefix, toolPermissions.tool);

// Set one member rule, stored as the admin made it. (What "no rule" means depends on the member
// default and on the tool's annotations, so an explicit choice is kept even when it matches.)
export async function setMemberRule(db: Db, prefix: string, tool: string, allowed: boolean, by: string | null) {
  await db.insert(toolPermissions).values({ role: 'member', serverPrefix: prefix, tool, allowed, updatedBy: by })
    .onConflictDoUpdate({ target: [toolPermissions.role, toolPermissions.serverPrefix, toolPermissions.tool], set: { allowed, updatedBy: by, updatedAt: new Date() } });
  await db.execute(sql`select pg_notify(${REGISTRY_CHANNEL}, 'permissions')`);
}

// Set or clear (auto) one chat confirmation override (C).
export async function setConfirmRule(db: Db, prefix: string, tool: string, mode: ConfirmMode, by: string | null) {
  if (mode === 'auto') {
    await db.delete(toolConfirmRules).where(and(eq(toolConfirmRules.serverPrefix, prefix), eq(toolConfirmRules.tool, tool)));
  } else {
    await db.insert(toolConfirmRules).values({ serverPrefix: prefix, tool, mode, updatedBy: by })
      .onConflictDoUpdate({ target: [toolConfirmRules.serverPrefix, toolConfirmRules.tool], set: { mode, updatedBy: by, updatedAt: new Date() } });
  }
  await db.execute(sql`select pg_notify(${REGISTRY_CHANNEL}, 'permissions')`);
}

// Keep rules in step with the registry: a removed server's rules go, a renamed prefix moves them.
export async function deleteServerRules(db: Db, prefix: string) {
  await db.delete(toolPermissions).where(eq(toolPermissions.serverPrefix, prefix));
  await db.delete(toolConfirmRules).where(eq(toolConfirmRules.serverPrefix, prefix));
}
export async function renameServerRules(db: Db, from: string, to: string) {
  await db.update(toolPermissions).set({ serverPrefix: to }).where(eq(toolPermissions.serverPrefix, from));
  await db.update(toolConfirmRules).set({ serverPrefix: to }).where(eq(toolConfirmRules.serverPrefix, from));
}
