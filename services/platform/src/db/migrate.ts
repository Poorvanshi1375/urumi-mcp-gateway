// Apply committed Drizzle migrations (drizzle/) to the platform database. Run by the Helm
// migration Job; safe to re-run (already-applied migrations are skipped). Connection comes from
// the standard PG* env vars (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE).
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
// Serialises concurrent runs (e.g. a manual run during a Helm upgrade).
const LOCK_ID = 727_001;

// A pg.Client cannot reconnect, so each attempt uses a fresh one.
async function connectWithRetry(attempts = 60): Promise<pg.Client> {
  for (let i = 1; ; i++) {
    const client = new pg.Client();
    try {
      await client.connect();
      await client.query('select 1');
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      if (i >= attempts) throw err;
      console.log(`[migrate] waiting for database (${i}/${attempts}): ${(err as Error).message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function applied(client: pg.Client): Promise<string[]> {
  const exists = await client.query(`select to_regclass('drizzle.__drizzle_migrations') as t`);
  if (!exists.rows[0].t) return [];
  const r = await client.query('select hash, created_at from drizzle.__drizzle_migrations order by id');
  return r.rows.map(row => `${row.created_at}:${String(row.hash).slice(0, 12)}`);
}

const client = await connectWithRetry();
await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
try {
  const before = await applied(client);
  await migrate(drizzle(client), { migrationsFolder });
  const after = await applied(client);
  console.log(`[migrate] applied before=${before.length} after=${after.length} new=${after.length - before.length}`);
  for (const m of after) console.log(`[migrate]   ${m}`);
} finally {
  await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
  await client.end();
}
