import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';

export function createDb(pool = new pg.Pool({ max: 10 })) {
  return { pool, db: drizzle(pool, { schema }) };
}

export type Db = ReturnType<typeof createDb>['db'];

// Postgres NOTIFY channel used to tell gateway processes that the upstream registry changed.
export const REGISTRY_CHANNEL = 'urumi_registry';
