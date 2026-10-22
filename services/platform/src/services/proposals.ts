// Chat confirmation (C): a write the agent wants to make is stored here and runs only when the
// user who asked confirms it. The row holds the exact tool and arguments, so the confirm request
// carries only the id and cannot change what runs. Each row is decided once; an unanswered row
// expires, and a new chat message declines any that is still waiting.
import { createHash } from 'node:crypto';
import { and, eq, gt, isNull, lt, lte } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { chatProposals } from '../db/schema.ts';
import { stable } from './pins.ts';

export type Proposal = typeof chatProposals.$inferSelect;
export const PROPOSAL_TTL_MS = 10 * 60_000;
const KEEP_DECIDED_MS = 30 * 24 * 3600_000;

// "Create product: name "Blue Mug", regular_price "499"". Values are shown, never executed; each
// is cut to 80 characters and at most 8 are listed.
export function summarize(title: string, args: Record<string, unknown>): string {
  const cut = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
  const entries = Object.entries(args);
  const shown = entries.slice(0, 8).map(([k, v]) => `${k} ${cut(typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? 'null')}`);
  return `${title}${shown.length ? `: ${shown.join(', ')}` : ''}${entries.length > 8 ? `, and ${entries.length - 8} more` : ''}`;
}

export async function createProposal(db: Db, p: { userId: string; tool: string; args: Record<string, unknown>; summary: string; requestId: string }) {
  // Housekeeping for this user only (the index covers it): decided rows are kept 30 days.
  await db.delete(chatProposals).where(and(eq(chatProposals.userId, p.userId), lt(chatProposals.createdAt, new Date(Date.now() - KEEP_DECIDED_MS))));
  const [row] = await db.insert(chatProposals).values({
    ...p, argsSha256: createHash('sha256').update(stable(p.args)).digest('hex'), expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
  }).returning();
  return row;
}

const waiting = (userId: string) => and(eq(chatProposals.userId, userId), isNull(chatProposals.decidedAt));

// A new message means the user moved on: what was waiting is declined (not run).
export async function declineWaiting(db: Db, userId: string): Promise<number> {
  await db.update(chatProposals).set({ decision: 'expired', decidedAt: new Date() }).where(and(waiting(userId), lte(chatProposals.expiresAt, new Date())));
  return (await db.update(chatProposals).set({ decision: 'rejected', decidedAt: new Date() }).where(waiting(userId)).returning({ id: chatProposals.id })).length;
}

export const listWaiting = (db: Db, userId: string) =>
  db.select().from(chatProposals).where(and(waiting(userId), gt(chatProposals.expiresAt, new Date()))).orderBy(chatProposals.createdAt);

export class ProposalError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// Decide one proposal, atomically: of two concurrent requests only one gets the row. Only the user
// it was made for can decide it; anyone else gets "not found", as if it did not exist.
export async function decide(db: Db, id: string, userId: string, decision: 'confirmed' | 'rejected'): Promise<Proposal> {
  const [row] = await db.update(chatProposals).set({ decision, decidedAt: new Date() })
    .where(and(eq(chatProposals.id, id), waiting(userId), gt(chatProposals.expiresAt, new Date()))).returning();
  if (row) return row;
  const [cur] = await db.select().from(chatProposals).where(and(eq(chatProposals.id, id), eq(chatProposals.userId, userId))).limit(1);
  if (!cur) throw new ProposalError(404, 'no such proposal');
  if (cur.decision === 'expired') throw new ProposalError(410, 'this proposal expired; ask again');
  if (cur.decidedAt) throw new ProposalError(409, `this proposal was already ${cur.decision}`);
  await db.update(chatProposals).set({ decision: 'expired', decidedAt: new Date() }).where(and(eq(chatProposals.id, id), isNull(chatProposals.decidedAt)));
  throw new ProposalError(410, 'this proposal expired; ask again');
}

export const setProposalAudit = (db: Db, id: string, auditId: number) =>
  db.update(chatProposals).set({ auditId }).where(eq(chatProposals.id, id));

export const publicProposal = (p: Proposal) => ({ id: p.id, name: p.tool, args: p.args, summary: p.summary, createdAt: p.createdAt, expiresAt: p.expiresAt });
