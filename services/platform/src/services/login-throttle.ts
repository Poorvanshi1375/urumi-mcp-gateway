// Sign-in throttling over a 15-minute window, shared by all gateway replicas (Postgres). 10 failures
// lock one email (stops guessing one account); 50 lock one client address (stops spraying many
// accounts, without locking out a shared office after a few typos).
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { loginFailures } from '../db/schema.ts';

export const LOGIN_LIMITS = { email: 10, ip: 50 } as const;
const WINDOW = sql`now() - interval '15 minutes'`;

export async function isThrottled(db: Db, email: string, ip: string): Promise<boolean> {
  const rows = await db.select({ key: loginFailures.key, n: sql<number>`count(*)::int` }).from(loginFailures)
    .where(and(inArray(loginFailures.key, [`email:${email}`, `ip:${ip}`]), gt(loginFailures.at, WINDOW)))
    .groupBy(loginFailures.key);
  const n = (k: string) => rows.find(r => r.key === k)?.n ?? 0;
  return n(`email:${email}`) >= LOGIN_LIMITS.email || n(`ip:${ip}`) >= LOGIN_LIMITS.ip;
}

export async function noteFailure(db: Db, email: string, ip: string) {
  await db.insert(loginFailures).values([{ key: `email:${email}` }, { key: `ip:${ip}` }]);
  await db.delete(loginFailures).where(lt(loginFailures.at, WINDOW));
}

// A successful sign-in clears that email's failures (the address keeps its count).
export async function clearEmail(db: Db, email: string) {
  await db.delete(loginFailures).where(eq(loginFailures.key, `email:${email}`));
}
