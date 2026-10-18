// Activity log (work item 6): sign-ins, keys, invites, users, servers and permissions. One row per
// action, under the person who did it. Never stores a secret: API keys appear by prefix only, and a
// credential change is recorded as "credential changed".
import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { activityEvents } from '../db/schema.ts';

export type Action =
  | 'login' | 'login_failed' | 'password_changed'
  | 'key_created' | 'key_revoked'
  | 'invite_sent' | 'invite_revoked' | 'invite_accepted'
  | 'user_created' | 'role_changed' | 'user_disabled' | 'user_enabled' | 'user_renamed'
  | 'server_added' | 'server_edited' | 'server_enabled' | 'server_disabled' | 'server_removed'
  | 'permission_changed' | 'tool_approved';
export type Actor = { id: string | null; email: string | null } | null;

export async function recordActivity(db: Db, actor: Actor, action: Action, target: string | null, detail?: Record<string, unknown>, ip?: string) {
  await db.insert(activityEvents).values({
    actorId: actor?.id ?? null, actorEmail: actor?.email ?? null, action, target, detail: detail ?? null, ip: ip ?? null,
  });
}

// Newest first. Members see rows they did or rows about themselves (e.g. an admin revoking their key).
export const listActivity = (db: Db, f: { actorId?: string; about?: string; limit?: number; before?: number } = {}) =>
  db.select().from(activityEvents)
    .where(and(
      f.actorId && f.about ? or(eq(activityEvents.actorId, f.actorId), eq(activityEvents.target, f.about)) : f.actorId ? eq(activityEvents.actorId, f.actorId) : undefined,
      f.before ? lt(activityEvents.id, f.before) : undefined,
    ))
    .orderBy(desc(activityEvents.id)).limit(Math.min(f.limit ?? 50, 200));
