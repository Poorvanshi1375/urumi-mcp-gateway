// Work claiming and writes for the provisioner's rows (hosted_servers, stores), H1 and H2.
// H1: a row is worked on by whoever holds its lease (lease_owner, lease_until). A claim is one short
// UPDATE that takes free rows with FOR UPDATE SKIP LOCKED, so two provisioner processes never take
// the same row and no lock is held while a step runs (a Helm install takes minutes). A crashed
// process's lease just runs out. The worker renews it every LEASE_RENEW_MS.
// H2: every write is a compare-and-set on the state the worker started from (and on its lease). A
// Delete from the dashboard sets state 'deleting' at any time; the install's next write then matches
// no row, and the worker stops instead of overwriting the delete.
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import type { Patch, State } from './steps.ts';

export type Table = 'hosted_servers' | 'stores';
export const LEASE_MS = 60_000;
export const LEASE_RENEW_MS = 20_000;

const tableSql = (t: Table) => {
  if (t !== 'hosted_servers' && t !== 'stores') throw new Error(`not a provisioner table: ${t}`);
  return sql.identifier(t);
};
const rows = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));

// Take up to `limit` rows that need work: provisioning or deleting, not leased by anyone live, and
// not waiting out a backoff. Returns them with the new lease.
export async function claim<T = Record<string, unknown>>(db: Db, table: Table, owner: string, limit: number, leaseMs = LEASE_MS): Promise<T[]> {
  const t = tableSql(table);
  return rows<T>(await db.execute(sql`
    update ${t} set lease_owner = ${owner}, lease_until = now() + make_interval(secs => ${leaseMs / 1000})
    where id in (
      select id from ${t}
      where state in ('provisioning', 'deleting')
        and (lease_until is null or lease_until < now())
        and (next_attempt_at is null or next_attempt_at <= now())
      order by created_at
      for update skip locked
      limit ${limit})
    returning *`));
}

// false: the lease is gone (expired and taken by another process, or released): stop working.
export async function renew(db: Db, table: Table, id: string, owner: string, leaseMs = LEASE_MS): Promise<boolean> {
  return rows(await db.execute(sql`update ${tableSql(table)} set lease_until = now() + make_interval(secs => ${leaseMs / 1000})
    where id = ${id} and lease_owner = ${owner} returning id`)).length === 1;
}

export async function release(db: Db, table: Table, id: string, owner: string): Promise<void> {
  await db.execute(sql`update ${tableSql(table)} set lease_owner = null, lease_until = null where id = ${id} and lease_owner = ${owner}`);
}

const COLUMNS: Record<string, string> = { state: 'state', step: 'step', error: 'error', attempts: 'attempts', deadlineAt: 'deadline_at', nextAttemptAt: 'next_attempt_at', readyAt: 'ready_at' };

// Apply a step-machine patch, only if the row is still in `expected` state and still leased by
// `owner`. false: superseded (a Delete arrived, or the lease was lost): the caller stops. A `gone`
// patch deletes the row (the end of a teardown), under the same conditions.
export async function writeIfState(db: Db, table: Table, id: string, owner: string, expected: State, patch: Patch): Promise<boolean> {
  const t = tableSql(table);
  const where = sql`id = ${id} and state = ${expected} and lease_owner = ${owner}`;
  if (patch.gone) return rows(await db.execute(sql`delete from ${t} where ${where} returning id`)).length === 1;
  const sets: SQL[] = [sql`updated_at = now()`];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLUMNS[k];
    if (!col) throw new Error(`unknown column in patch: ${k}`);
    sets.push(sql`${sql.identifier(col)} = ${v ?? null}`);
  }
  return rows(await db.execute(sql`update ${t} set ${sql.join(sets, sql`, `)} where ${where} returning id`)).length === 1;
}

// The dashboard's Delete: from any state; wins over a running install (whose next write then fails).
export async function requestDelete(db: Db, table: Table, id: string): Promise<boolean> {
  return rows(await db.execute(sql`update ${tableSql(table)} set state = 'deleting', error = null, attempts = 0, next_attempt_at = null, updated_at = now()
    where id = ${id} and state <> 'deleting' returning id`)).length === 1;
}

// The dashboard's Retry: only a failed row, with a fresh deadline.
export async function requestRetry(db: Db, table: Table, id: string, timeoutMs: number): Promise<boolean> {
  return rows(await db.execute(sql`update ${tableSql(table)} set state = 'provisioning', error = null, attempts = 0, next_attempt_at = null,
    deadline_at = now() + make_interval(secs => ${timeoutMs / 1000}), updated_at = now()
    where id = ${id} and state = 'failed' returning id`)).length === 1;
}
