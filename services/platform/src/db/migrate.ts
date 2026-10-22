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

// The gateway does not run as the database owner (idea AC). Migrations run here, as the owner; the
// app connects as APP_DB_USER, which may read and write every table but may only add audit rows and
// complete them: on audit_events it has SELECT, INSERT and UPDATE of exactly the columns
// finishAudit and the pending sweep write. It can never delete an audit row or change who made a
// call, when, with which arguments or under which request id. Applied on every run (idempotent),
// so a table added by a later migration gets its grants too, and the password follows the Secret.
// (A static SQL migration cannot do this: the password comes from the Secret.)
const AUDIT_UPDATABLE = ['upstream_id', 'server_prefix', 'tool', 'duration_ms', 'outcome', 'error'];
async function ensureAppRole(c: pg.Client) {
  const role = process.env.APP_DB_USER, password = process.env.APP_DB_PASSWORD;
  if (!role || !password) { console.log('[migrate] APP_DB_USER/APP_DB_PASSWORD not set: the app keeps the owner role'); return; }
  const exists = (await c.query('select 1 from pg_roles where rolname = $1', [role])).rowCount;
  // DDL takes no bind parameters: quote identifier and literal with format().
  const ddl = (await c.query(`select format(${exists ? "'ALTER ROLE %I WITH LOGIN PASSWORD %L'" : "'CREATE ROLE %I WITH LOGIN PASSWORD %L'"}, $1::text, $2::text) as q`, [role, password])).rows[0].q;
  await c.query(ddl);
  const q = async (sql: string) => c.query((await c.query('select format($1, $2::text) as q', [sql, role])).rows[0].q);
  await q('GRANT USAGE ON SCHEMA public TO %I');
  await q('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I');
  await q('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I');
  await q('REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM %I');
  await q(`GRANT UPDATE (${AUDIT_UPDATABLE.join(', ')}) ON audit_events TO %I`);
  console.log(`[migrate] app role ${role}: full access to the app tables; audit_events insert, select and update of ${AUDIT_UPDATABLE.join(', ')} only`);
}

// The provisioner (T1-2/T1-3) has its own role: it holds Kubernetes rights, so if it were ever
// compromised it must not also get the platform's users, keys, sessions or audit log. It may manage
// its own two tables, add activity rows, delete a removed tenant's permission rules, and on
// upstreams see and change only the rows it manages (managed_by set), by row-level security: it
// holds the key that decrypts credentials, and must never read or repoint the woo or ship rows.
// RLS needs a policy for every role that uses the table, so the app role's "all rows" policy is
// created first and everything runs in one transaction: there is no moment where the gateway sees
// no servers. The owner (migrations) is exempt from RLS, as Postgres does for table owners.
const PROVISIONER_TABLES = ['hosted_servers', 'stores'];
async function ensureProvisionerRole(c: pg.Client) {
  const role = process.env.PROVISIONER_DB_USER, password = process.env.PROVISIONER_DB_PASSWORD, app = process.env.APP_DB_USER;
  if (!role || !password) { console.log('[migrate] PROVISIONER_DB_USER/PROVISIONER_DB_PASSWORD not set: no provisioner role'); return; }
  if (!app || !process.env.APP_DB_PASSWORD) throw new Error('the provisioner role needs the app role too (APP_DB_USER): row-level security on upstreams needs a policy for the app');
  const f = async (sql: string, ...args: string[]) => (await c.query(`select format($1${args.map((_, i) => `, $${i + 2}::text`).join('')}) as q`, [sql, ...args])).rows[0].q as string;
  const exists = (await c.query('select 1 from pg_roles where rolname = $1', [role])).rowCount;
  await c.query('begin');
  try {
    await c.query(await f(exists ? 'ALTER ROLE %I WITH LOGIN PASSWORD %L' : 'CREATE ROLE %I WITH LOGIN PASSWORD %L', role, password));
    // Start from nothing on every run, so a grant removed here is removed in the database too.
    await c.query(await f('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', role));
    await c.query(await f('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', role));
    await c.query(await f('GRANT USAGE ON SCHEMA public TO %I', role));
    for (const t of PROVISIONER_TABLES) await c.query(await f('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, role));
    await c.query(await f('GRANT SELECT, INSERT, UPDATE, DELETE ON upstreams TO %I', role));
    // SELECT too: a DELETE ... WHERE server_prefix = ... needs to read the column it filters on.
    await c.query(await f('GRANT SELECT, DELETE ON tool_permissions, tool_confirm_rules TO %I', role));
    await c.query(await f('GRANT INSERT ON activity_events TO %I', role));
    await c.query(await f('GRANT USAGE ON SEQUENCE activity_events_id_seq TO %I', role));
    await c.query('DROP POLICY IF EXISTS upstreams_app_all ON upstreams');
    await c.query(await f('CREATE POLICY upstreams_app_all ON upstreams TO %I USING (true) WITH CHECK (true)', app));
    await c.query('DROP POLICY IF EXISTS upstreams_provisioner_managed ON upstreams');
    await c.query(await f('CREATE POLICY upstreams_provisioner_managed ON upstreams TO %I USING (managed_by IS NOT NULL) WITH CHECK (managed_by IS NOT NULL)', role));
    await c.query('ALTER TABLE upstreams ENABLE ROW LEVEL SECURITY');
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  }
  console.log(`[migrate] provisioner role ${role}: ${PROVISIONER_TABLES.join(', ')}; upstreams rows it manages only (row-level security); delete of permission rules; insert into activity_events`);
}

const client = await connectWithRetry();
await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
try {
  const before = await applied(client);
  await migrate(drizzle(client), { migrationsFolder });
  const after = await applied(client);
  console.log(`[migrate] applied before=${before.length} after=${after.length} new=${after.length - before.length}`);
  for (const m of after) console.log(`[migrate]   ${m}`);
  await ensureAppRole(client);
  await ensureProvisionerRole(client);
} finally {
  await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
  await client.end();
}
