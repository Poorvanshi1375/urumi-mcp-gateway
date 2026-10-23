// The provisioner (T1-2/T1-3): the only process with a Kubernetes token. It runs hosted MCP servers
// and bonus stores from the desired-state rows in Postgres (hosted_servers, stores); the gateway and
// dashboard only write those rows. It connects to Postgres as its own role (urumi_provisioner: its
// tables, and on upstreams only the rows it manages), and to the Kubernetes API with its service
// account, whose rights end at namespaces this install manages (ClusterRoles + admission policies
// in the chart). It never calls a tenant pod: a tenant is ready when the gateway reports its server
// connected (H7).
//
// Each tick checks both connections, then claims hosted servers that need work (H1: a lease per row,
// so no lock is held while a step runs), runs their steps (provision/hosted.ts, provision/steps.ts)
// and writes the result as a compare-and-set on the row's state and lease (H2). Bonus stores arrive
// in P9. /healthz fails if the loop has not ticked for 60 s (H11), /readyz if the last tick could
// not reach Postgres or the Kubernetes API. NOTIFY on PROVISION_CHANNEL wakes it at once.
import http from 'node:http';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { createDb } from './db/client.ts';
import { activityEvents, hostedServers, stores } from './db/schema.ts';
import { createCredentialCipher } from './lib/crypto.ts';
import { checkAllowPrefixes } from './lib/image-ref.ts';
import { inClusterClient } from './lib/k8s.ts';
import { hostedSteps, hostedTeardown, lastWarning, type HostedEnv, type HostedRow } from './provision/hosted.ts';
import { claim, LEASE_RENEW_MS, release, renew, writeIfState, type Table } from './provision/rows.ts';
import { storeNamespace, storeSteps, storeTeardown, type StoreEnv, type StoreRow } from './provision/stores.ts';
import { createHelm } from './lib/helm.ts';
import { deletePass, provisionPass, type Step } from './provision/steps.ts';
import { PROVISION_CHANNEL } from './services/hosted.ts';

const TICK_MS = Number(process.env.PROVISIONER_TICK_MS ?? 10_000);
const STALL_MS = 60_000;
const port = Number(process.env.HEALTH_PORT ?? 8081);
const releaseNamespace = process.env.RELEASE_NAMESPACE;
if (!releaseNamespace) throw new Error('missing required env RELEASE_NAMESPACE');
// The lease owner name for this process (H1): the pod name, unique while it runs.
export const owner = process.env.HOSTNAME ?? `provisioner-${process.pid}`;

const log = (level: 'info' | 'warn' | 'error', msg: string, o: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, owner, ...o }));

const need = (name: string) => process.env[name] || (() => { throw new Error(`missing required env ${name}`); })();
const PARALLEL = Number(process.env.PROVISIONER_PARALLEL ?? 2);

const { pool, db } = createDb(new pg.Pool({ max: 4 }));
const k8s = inClusterClient();
const env: HostedEnv = {
  db, k8s, cipher: createCredentialCipher(need('PLATFORM_ENCRYPTION_KEY')),
  releaseNamespace: releaseNamespace!, releaseName: need('RELEASE_NAME'),
  serviceAccount: need('PROVISIONER_SERVICE_ACCOUNT'), tenantRole: need('TENANT_ROLE'),
  allowedImages: checkAllowPrefixes(need('ALLOWED_IMAGES').split(',').filter(Boolean)),
  bridgeImage: process.env.BRIDGE_IMAGE || undefined,
};
const activity = (action: string, target: string, detail?: Record<string, unknown>) =>
  db.insert(activityEvents).values({ actorEmail: 'provisioner', action, target, detail }).catch(e => log('warn', 'activity write failed', { err: String(e) }));

// Bonus stores (multi-store): the same loop, with the store chart installed by Helm.
const storesOn = process.env.STORES === 'on';
const storeEnv: StoreEnv | undefined = storesOn ? {
  ...env, helm: createHelm(), chart: process.env.STORE_CHART ?? '/app/charts/urumi-store',
  wooMcpImage: { repository: need('WOO_MCP_IMAGE_REPOSITORY'), tag: need('WOO_MCP_IMAGE_TAG') },
  pluginImage: process.env.WOOCOMMERCE_PLUGIN_IMAGE || null,
  homeUrlTemplate: need('STORE_HOME_URL_TEMPLATE'), signingUrlTemplate: need('STORE_SIGNING_URL_TEMPLATE'),
  extraValues: JSON.parse(process.env.STORE_EXTRA_VALUES || '{}'),
} : undefined;

type Kind = { table: Table; label: string; load: (id: string) => Promise<any>; steps: (row: any) => Step<null>[]; teardown: (row: any) => Step<null>[]; hint?: (row: any) => Promise<string | null> };
const KINDS: Kind[] = [
  { table: 'hosted_servers', label: 'hosted server', load: async id => (await db.select().from(hostedServers).where(eq(hostedServers.id, id)))[0],
    steps: r => hostedSteps(env, r), teardown: r => hostedTeardown(env, r), hint: r => lastWarning(env, r) },
  ...(storeEnv ? [{ table: 'stores' as Table, label: 'store', load: async (id: string) => (await db.select().from(stores).where(eq(stores.id, id)))[0],
    steps: (r: StoreRow) => storeSteps(storeEnv, r), teardown: (r: StoreRow) => storeTeardown(storeEnv, r),
    hint: (r: StoreRow) => lastWarning(env, { prefix: '', id: r.id } as HostedRow, storeNamespace(r.slug)) }] : []),
];

// One pass over one claimed row, under its lease.
async function reconcile(kind: Kind, id: string) {
  const row = await kind.load(id);
  if (!row || row.leaseOwner !== owner) return;
  const name = row.prefix ?? row.slug;
  const keep = setInterval(() => void renew(db, kind.table, id, owner).then(ok => { if (!ok) log('warn', 'lease lost', { name }); }).catch(() => {}), LEASE_RENEW_MS);
  const what = kind.table === 'stores' ? 'store' : 'hosted';
  try {
    const now = new Date();
    const patch = row.state === 'deleting'
      ? await deletePass(row, kind.teardown(row), null, { now })
      : await provisionPass(row, kind.steps(row), null, { now, hint: kind.hint ? () => kind.hint!(row) : undefined });
    if (!Object.keys(patch).length) return;
    if (!(await writeIfState(db, kind.table, id, owner, row.state, patch))) { log('info', 'superseded (deleted or lease lost)', { name }); return; }
    if (patch.gone) { log('info', `${kind.label} removed`, { name }); await activity(`${what}_removed`, name); }
    else if (patch.state === 'ready') { log('info', `${kind.label} ready`, { name }); await activity(`${what}_ready`, name); }
    else if (patch.state === 'failed') { log('warn', `${kind.label} failed`, { name, step: patch.step, error: patch.error }); await activity(`${what}_failed`, name, { step: patch.step, error: patch.error }); }
    else if (patch.error) log('warn', `${kind.label} step failed, will retry`, { name, error: patch.error, attempts: patch.attempts });
  } catch (e) {
    log('error', 'reconcile crashed', { name, err: (e as Error).message.slice(0, 300) });
  } finally {
    clearInterval(keep);
    await release(db, kind.table, id, owner).catch(() => {});
  }
}

let lastTick = 0, ready = false, lastProblem: string | null = null;
const inFlight = new Map<Table, Set<string>>(KINDS.map(k => [k.table, new Set<string>()]));
async function tick() {
  try {
    const [r] = (await db.execute(sql`select
      (select count(*) from hosted_servers where state in ('provisioning', 'deleting'))::int as hosted,
      (select count(*) from stores where state in ('provisioning', 'deleting'))::int as stores`)).rows as { hosted: number; stores: number }[];
    if (!(await k8s.get('Namespace', undefined, releaseNamespace!))) throw new Error(`namespace ${releaseNamespace} not found`);
    if (lastProblem || !ready) log('info', 'provisioner connected', { postgres: 'ok', kubernetes: 'ok', stores: storesOn, waiting: r });
    ready = true; lastProblem = null;
    // Up to PARALLEL rows of each kind at once, each in the background: a slow step (a Helm install)
    // never holds up another row, and a free slot is filled on the next tick.
    for (const kind of KINDS) {
      const busy = inFlight.get(kind.table)!;
      if (busy.size >= PARALLEL) continue;
      const work = await claim<{ id: string }>(db, kind.table, owner, PARALLEL - busy.size);
      for (const w of work) {
        busy.add(w.id);
        void reconcile(kind, w.id).finally(() => { busy.delete(w.id); void loop(); });
      }
    }
  } catch (e) {
    const problem = (e as Error).message.slice(0, 300);
    if (problem !== lastProblem) log('warn', 'provisioner tick failed', { err: problem });
    ready = false; lastProblem = problem;
  } finally {
    lastTick = Date.now();
  }
}

const health = http.createServer((req, res) => {
  const live = Date.now() - lastTick < STALL_MS;
  const ok = req.url === '/healthz' ? live : req.url === '/readyz' ? live && ready : false;
  res.writeHead(req.url === '/healthz' || req.url === '/readyz' ? (ok ? 200 : 503) : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok, lastTickMsAgo: Date.now() - lastTick, problem: lastProblem }));
});

let timer: NodeJS.Timeout | undefined, running = false, again = false;
const loop = async () => {
  clearTimeout(timer);
  if (running) { again = true; return; }
  running = true;
  try { await tick(); } finally { running = false; }
  timer = setTimeout(loop, again ? 0 : TICK_MS); again = false;
};
// The API NOTIFYs when it adds a row or asks for a delete: start a pass at once.
const listener = new pg.Client();
listener.on('notification', () => void loop());
listener.on('error', e => log('warn', 'listen connection failed; the timer still runs', { err: e.message }));
await listener.connect().then(() => listener.query(`LISTEN ${PROVISION_CHANNEL}`)).catch(e => log('warn', 'listen failed; the timer still runs', { err: (e as Error).message }));
const shutdown = async () => { clearTimeout(timer); health.close(); await listener.end().catch(() => {}); await pool.end().catch(() => {}); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

health.listen(port, '0.0.0.0', () => log('info', 'provisioner started', { releaseNamespace, tickMs: TICK_MS, healthPort: port }));
void loop();
