// Audit log (T3/T4): one row per tools/call and per rejected request.
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { auditEvents, users } from '../db/schema.ts';

export type Outcome = 'ok' | 'tool_error' | 'timeout' | 'upstream_unreachable' | 'rejected' | 'denied';
export type AuditInput = {
  userId?: string | null;
  apiKeyId?: string | null;
  keyPrefix?: string | null;
  source?: 'mcp' | 'chat';
  upstreamId?: string | null;
  serverPrefix?: string | null;
  tool?: string | null;
  durationMs?: number | null;
  outcome: Outcome;
  error?: string | null;
};

export async function recordAudit(db: Db, e: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    userId: e.userId ?? null,
    apiKeyId: e.apiKeyId ?? null,
    keyPrefix: e.keyPrefix ?? null,
    source: e.source ?? 'mcp',
    upstreamId: e.upstreamId ?? null,
    serverPrefix: e.serverPrefix ?? null,
    tool: e.tool ?? null,
    durationMs: e.durationMs ?? null,
    outcome: e.outcome,
    error: e.error ? e.error.slice(0, 500) : null,
  });
}

export type AuditFilter = { limit?: number; userId?: string; server?: string; outcome?: Outcome; before?: number };

// Newest first. `before` is an audit id for paging (rows with a smaller id).
export const listAudit = (db: Db, f: AuditFilter = {}) =>
  db.select({
    id: auditEvents.id, at: auditEvents.createdAt, userId: auditEvents.userId, user: users.email, keyPrefix: auditEvents.keyPrefix,
    source: auditEvents.source, server: auditEvents.serverPrefix, tool: auditEvents.tool,
    durationMs: auditEvents.durationMs, outcome: auditEvents.outcome, error: auditEvents.error,
  }).from(auditEvents).leftJoin(users, eq(users.id, auditEvents.userId))
    .where(and(
      f.userId ? eq(auditEvents.userId, f.userId) : undefined,
      f.server ? eq(auditEvents.serverPrefix, f.server) : undefined,
      f.outcome ? eq(auditEvents.outcome, f.outcome) : undefined,
      f.before ? lt(auditEvents.id, f.before) : undefined,
    ))
    .orderBy(desc(auditEvents.id)).limit(Math.min(f.limit ?? 50, 500));
