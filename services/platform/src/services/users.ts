import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { hashPassword } from '../lib/crypto.ts';

export type Role = 'admin' | 'member';
export type User = typeof users.$inferSelect;

export async function createUser(db: Db, input: { email: string; name?: string; role: Role; password?: string }): Promise<User> {
  const [row] = await db.insert(users).values({
    email: input.email.trim().toLowerCase(),
    name: input.name ?? null,
    role: input.role,
    passwordHash: input.password ? await hashPassword(input.password) : null,
  }).returning();
  return row;
}

export const findUserByEmail = async (db: Db, email: string) =>
  (await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1))[0];

export const listUsers = (db: Db) => db.select().from(users).orderBy(asc(users.createdAt));

export async function countUsers(db: Db): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return r.n;
}

// Never return password hashes to callers.
export const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt, disabledAt: u.disabledAt });

export const findUserById = async (db: Db, id: string) =>
  (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];

export class LastAdminError extends Error {}

// Change role / enabled state. Refuses to leave the system without an active admin.
export async function updateUser(db: Db, id: string, patch: { role?: Role; disabled?: boolean; name?: string }): Promise<User | undefined> {
  return db.transaction(async tx => {
    const [target] = await tx.select().from(users).where(eq(users.id, id)).for('update');
    if (!target) return undefined;
    const losesAdmin = target.role === 'admin' && !target.disabledAt && (patch.role === 'member' || patch.disabled === true);
    if (losesAdmin) {
      // Lock every active admin row so two admins demoting each other concurrently cannot both pass.
      const admins = await tx.select({ id: users.id }).from(users)
        .where(sql`${users.role} = 'admin' and ${users.disabledAt} is null`).for('update');
      if (admins.filter(a => a.id !== id).length === 0) throw new LastAdminError('cannot demote or disable the last active admin');
    }
    const set: Partial<typeof users.$inferInsert> = {};
    if (patch.role) set.role = patch.role;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.disabled !== undefined) set.disabledAt = patch.disabled ? new Date() : null;
    const [row] = await tx.update(users).set(set).where(eq(users.id, id)).returning();
    return row;
  });
}

export async function setPassword(db: Db, id: string, password: string) {
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, id));
}
