// Audit log (T3/T4): one row per tools/call and per rejected request.
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { auditEvents, users } from '../db/schema.ts';

export type Outcome = 'ok' | 'tool_error' | 'timeout' | 'upstream_unreachable' | 'rejected' | 'denied' | 'busy';
export type RowOutcome = Outcome | 'pending' | 'unknown';
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
  oauthGrantId?: string | null;
  argsSha256?: string | null;
  requestId?: string | null;
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
    oauthGrantId: e.oauthGrantId ?? null,
    outcome: e.outcome,
    error: e.error ? e.error.slice(0, 500) : null,
  });
}

// Write-ahead audit for tool calls: the row exists before the call is sent, so no call can happen
// without one. beginAudit inserts it as "pending" (the caller refuses the call if that fails);
// finishAudit sets the outcome. A row left pending (the update failed, or the replica stopped
// mid-call) is turned into "unknown" by sweepPendingAudit, so it is still evidence of the attempt.
export async function beginAudit(db: Db, e: Omit<AuditInput, 'outcome'>): Promise<number> {
  const [row] = await db.insert(auditEvents).values({
    userId: e.userId ?? null, apiKeyId: e.apiKeyId ?? null, keyPrefix: e.keyPrefix ?? null, source: e.source ?? 'mcp',
    serverPrefix: e.serverPrefix ?? null, tool: e.tool ?? null, oauthGrantId: e.oauthGrantId ?? null, argsSha256: e.argsSha256 ?? null, requestId: e.requestId ?? null, outcome: 'pending',
  }).returning({ id: auditEvents.id });
  return row!.id;
}
export async function finishAudit(db: Db, id: number, e: Pick<AuditInput, 'upstreamId' | 'serverPrefix' | 'tool' | 'durationMs' | 'outcome' | 'error'>) {
  await db.update(auditEvents).set({
    upstreamId: e.upstreamId ?? null, serverPrefix: e.serverPrefix ?? null, tool: e.tool ?? null,
    durationMs: e.durationMs ?? null, outcome: e.outcome, error: e.error ? e.error.slice(0, 500) : null,
  }).where(eq(auditEvents.id, id));
}
export const sweepPendingAudit = (db: Db, olderThanMs: number) =>
  db.update(auditEvents).set({ outcome: 'unknown', error: 'no result was recorded (the gateway stopped or the audit update failed)' })
    .where(and(eq(auditEvents.outcome, 'pending'), lt(auditEvents.createdAt, new Date(Date.now() - olderThanMs)))).returning({ id: auditEvents.id });

export type AuditFilter = { limit?: number; userId?: string; server?: string; outcome?: RowOutcome; before?: number; requestId?: string; max?: number };

// Newest first. `before` is an audit id for paging (rows with a smaller id).
export const listAudit = (db: Db, f: AuditFilter = {}) =>
  db.select({
    id: auditEvents.id, at: auditEvents.createdAt, userId: auditEvents.userId, user: users.email, keyPrefix: auditEvents.keyPrefix,
    source: auditEvents.source, server: auditEvents.serverPrefix, tool: auditEvents.tool,
    durationMs: auditEvents.durationMs, outcome: auditEvents.outcome, error: auditEvents.error, argsSha256: auditEvents.argsSha256, requestId: auditEvents.requestId,
  }).from(auditEvents).leftJoin(users, eq(users.id, auditEvents.userId))
    .where(and(
      f.userId ? eq(auditEvents.userId, f.userId) : undefined,
      f.server ? eq(auditEvents.serverPrefix, f.server) : undefined,
      f.outcome ? eq(auditEvents.outcome, f.outcome) : undefined,
      f.requestId ? eq(auditEvents.requestId, f.requestId) : undefined,
      f.before ? lt(auditEvents.id, f.before) : undefined,
    ))
    .orderBy(desc(auditEvents.id)).limit(Math.min(f.limit ?? 50, f.max ?? 500));
