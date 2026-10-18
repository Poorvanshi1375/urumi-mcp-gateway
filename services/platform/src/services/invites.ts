// Invites (T5): an admin invites an email with a role; the one-time token (shown once, stored as
// SHA-256) lets that person set a password and become a user.
import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { invites, users } from '../db/schema.ts';
import { hashPassword, sha256 } from '../lib/crypto.ts';
import type { Role } from './users.ts';

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export async function createInvite(db: Db, input: { email: string; role: Role; invitedBy: string }) {
  const token = randomBytes(24).toString('base64url');
  const [row] = await db.insert(invites).values({
    email: input.email.trim().toLowerCase(), role: input.role, tokenHash: sha256(token),
    invitedBy: input.invitedBy, expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  }).returning();
  return { token, invite: publicInvite(row) };
}

export const listInvites = async (db: Db) =>
  (await db.select().from(invites).orderBy(desc(invites.createdAt))).map(publicInvite);

export async function deleteInvite(db: Db, id: string) {
  return (await db.delete(invites).where(and(eq(invites.id, id), isNull(invites.acceptedAt))).returning()).length > 0;
}

export async function findOpenInvite(db: Db, token: string) {
  const [row] = await db.select().from(invites)
    .where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date()))).limit(1);
  return row;
}

// Accept atomically: the invite is consumed in the same transaction that creates the user.
export async function acceptInvite(db: Db, token: string, input: { name?: string; password: string }) {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async tx => {
    const [inv] = await tx.update(invites).set({ acceptedAt: new Date() })
      .where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date())))
      .returning();
    if (!inv) return undefined;
    const [user] = await tx.insert(users).values({ email: inv.email, name: input.name ?? null, role: inv.role, passwordHash }).returning();
    return user;
  });
}

const publicInvite = (i: typeof invites.$inferSelect) => ({
  id: i.id, email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt, acceptedAt: i.acceptedAt,
  status: i.acceptedAt ? 'accepted' : i.expiresAt < new Date() ? 'expired' : 'pending',
});
