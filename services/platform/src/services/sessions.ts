// Dashboard sessions: a random token in an httpOnly cookie; only its SHA-256 is stored.
import { randomBytes } from 'node:crypto';
import { and, eq, gt, lt, ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';
import { sha256 } from '../lib/crypto.ts';

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({ id: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
  // Opportunistic cleanup of expired sessions.
  void db.delete(sessions).where(lt(sessions.expiresAt, new Date())).catch(() => {});
  return token;
}

export async function sessionUser(db: Db, token: string) {
  const [r] = await db.select({ user: users }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date()))).limit(1);
  return r?.user;
}

export const deleteSession = (db: Db, token: string) => db.delete(sessions).where(eq(sessions.id, sha256(token)));
export const deleteUserSessions = (db: Db, userId: string) => db.delete(sessions).where(eq(sessions.userId, userId));

// After a password change: sign out every other session of this user, keep the current one.
export const deleteOtherSessions = (db: Db, userId: string, keepToken: string | undefined) =>
  db.delete(sessions).where(and(eq(sessions.userId, userId), keepToken ? ne(sessions.id, sha256(keepToken)) : undefined));
