// Per-user gateway API keys (T2): shown once at creation, stored as SHA-256, revocable.
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { apiKeys, users } from '../db/schema.ts';
import { newApiKey, sha256 } from '../lib/crypto.ts';

export type ApiKey = typeof apiKeys.$inferSelect;

export async function createApiKey(db: Db, userId: string, name: string): Promise<{ key: string; row: ApiKey }> {
  const k = newApiKey();
  const [row] = await db.insert(apiKeys).values({ userId, name, prefix: k.prefix, keyHash: k.hash }).returning();
  return { key: k.key, row };
}

export async function revokeApiKey(db: Db, idOrPrefix: string, ownerId?: string): Promise<ApiKey | undefined> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrPrefix);
  const match = isUuid ? eq(apiKeys.id, idOrPrefix) : eq(apiKeys.prefix, idOrPrefix);
  const [row] = await db.update(apiKeys).set({ revokedAt: new Date() })
    .where(and(match, isNull(apiKeys.revokedAt), ownerId ? eq(apiKeys.userId, ownerId) : undefined))
    .returning();
  return row;
}

export const listApiKeys = (db: Db, userId?: string) =>
  db.select({
    id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, userId: apiKeys.userId, email: users.email,
    createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt,
  }).from(apiKeys).innerJoin(users, eq(users.id, apiKeys.userId))
    .where(userId ? eq(apiKeys.userId, userId) : undefined)
    .orderBy(desc(apiKeys.createdAt));

// Resolve a presented key. Every request is re-checked against the database, so a revocation
// takes effect on the very next request.
export async function lookupApiKey(db: Db, presented: string) {
  const [r] = await db.select({ key: apiKeys, user: users }).from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.keyHash, sha256(presented))).limit(1);
  return r;
}

// Record use at most once a minute per key to avoid a write on every request.
export async function touchApiKey(db: Db, id: string) {
  await db.update(apiKeys).set({ lastUsedAt: new Date() })
    .where(and(eq(apiKeys.id, id), or(isNull(apiKeys.lastUsedAt), sql`${apiKeys.lastUsedAt} < now() - interval '60 seconds'`)));
}
