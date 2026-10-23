// A bonus store (multi-store): the urumi-store chart in its own namespace store-<slug>, with its own
// MySQL, a generated Secret, an Ingress host, and its own woo-mcp, registered as the server <slug>.
// Same machinery as hosted servers (provision/hosted.ts): idempotent steps, never adopt a namespace,
// Ready when the gateway has listed the store's tools (H7), teardown by deleting the namespace (H8).
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { REGISTRY_CHANNEL } from '../db/client.ts';
import { stores, upstreams } from '../db/schema.ts';
import type { Helm } from '../lib/helm.ts';
import type { K8sObject } from '../lib/k8s.ts';
import { deleteUpstream } from '../services/upstreams.ts';
import type { HostedEnv } from './hosted.ts';
import type { Step } from './steps.ts';

export type StoreRow = typeof stores.$inferSelect;
export type StoreEnv = HostedEnv & {
  helm: Helm;
  chart: string;                         // /app/charts/urumi-store
  wooMcpImage: { repository: string; tag: string };
  pluginImage: string | null;            // the pre-baked WooCommerce zip, or download
  homeUrlTemplate: string;               // e.g. http://{host}:9080 (k3d), http://{host} (VPS)
  signingUrlTemplate: string;            // the URL WooCommerce sees in-cluster
  extraValues: Record<string, unknown>;  // per environment (e.g. the k3d Service port)
};

export const storeNamespace = (slug: string) => `store-${slug}`;
const RELEASE = 'store';
const labels = (env: StoreEnv) => ({ 'urumi.dev/managed-by': 'urumi-provisioner', 'urumi.dev/platform': env.releaseNamespace, 'urumi.dev/kind': 'store' });
const fill = (template: string, host: string) => template.replace('{host}', host);
const hex = (n: number) => randomBytes(n).toString('hex');
const password = () => randomBytes(24).toString('base64url');

async function ownNamespace(env: StoreEnv, row: StoreRow): Promise<K8sObject | undefined> {
  const ns = await env.k8s.get('Namespace', undefined, storeNamespace(row.slug));
  if (ns && ns.metadata.annotations?.['urumi.dev/owner-id'] !== row.id) throw new Error(`namespace ${storeNamespace(row.slug)} exists and is not ours`);
  return ns;
}

// The store chart's values for this store: nothing secret (the chart reads the Secret by name).
export function storeValues(env: StoreEnv, row: StoreRow): Record<string, unknown> {
  const deep = (a: any, b: any): any => (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)
    ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, k in b ? deep(a[k], b[k]) : a[k]])) : b ?? a);
  return deep({
    store: { host: row.host, homeUrl: fill(env.homeUrlTemplate, row.host), title: row.title, adminEmail: row.adminEmail, currency: row.currency, country: row.country, timezone: row.timezone },
    secrets: { existingSecret: 'store-secrets' },
    woocommerce: env.pluginImage ? { pluginImage: env.pluginImage } : {},
    mcp: { enabled: true, image: env.wooMcpImage, signingBaseUrl: fill(env.signingUrlTemplate, row.host),
      gateway: { namespace: env.releaseNamespace, podLabels: { app: 'platform', 'app.kubernetes.io/instance': env.releaseName } } },
    // The platform's own woo-mcp never talks to a bonus store: only the store's own server does.
    networkPolicy: { storeApiClients: [] },
  }, env.extraValues);
}

export function storeSteps(env: StoreEnv, row: StoreRow): Step<null>[] {
  const ns = storeNamespace(row.slug);
  const meta = (name: string) => ({ name, namespace: ns, labels: labels(env) });
  const apply = async (obj: K8sObject) => { await env.k8s.apply(obj); return 'done' as const; };
  return [
    { name: 'namespace', run: async () => {
      await ownNamespace(env, row);
      // Restricted Pod Security: the whole store chart passes it (checked with a dry run, H5).
      return apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, annotations: { 'urumi.dev/owner-id': row.id },
        labels: { ...labels(env), 'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/warn': 'restricted', 'pod-security.kubernetes.io/audit': 'restricted' } } });
    } },
    { name: 'rolebinding', run: () => apply({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: meta('urumi-provisioner'),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: env.tenantRole },
      subjects: [{ kind: 'ServiceAccount', name: env.serviceAccount, namespace: env.releaseNamespace }] } as K8sObject) },
    { name: 'quota', run: () => apply({ apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta('tenant'), spec: { hard: {
      pods: '8', 'requests.cpu': '1', 'limits.cpu': '4', 'requests.memory': '1536Mi', 'limits.memory': '3Gi',
      persistentvolumeclaims: '2', 'requests.storage': '10Gi', 'services.loadbalancers': '0', 'services.nodeports': '0' } } } as K8sObject) },
    // Per container and per volume: the chart's largest container is 1 CPU / 768Mi and its largest
    // volume 5Gi; a container without its own resources gets the defaults.
    { name: 'limits', run: () => apply({ apiVersion: 'v1', kind: 'LimitRange', metadata: meta('tenant'), spec: { limits: [
      { type: 'Container', max: { cpu: '1', memory: '1Gi' }, min: { cpu: '10m', memory: '16Mi' },
        default: { cpu: '250m', memory: '256Mi' }, defaultRequest: { cpu: '50m', memory: '64Mi' } },
      { type: 'PersistentVolumeClaim', max: { storage: '5Gi' } },
    ] } } as K8sObject) },
    { name: 'secret', run: async () => {
      // Made once and kept: MySQL keeps the first password it was given, so it must never change.
      if (await env.k8s.get('Secret', ns, 'store-secrets')) return 'done';
      const data: Record<string, string> = { 'mysql-root-password': password(), 'mysql-password': password(), 'wp-admin-password': password(),
        'woo-consumer-key': `ck_${hex(20)}`, 'woo-consumer-secret': `cs_${hex(20)}`, 'mcp-token': randomBytes(32).toString('base64url') };
      return apply({ apiVersion: 'v1', kind: 'Secret', metadata: meta('store-secrets'), type: 'Opaque',
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) } as K8sObject);
    } },
    { name: 'helm', run: async () => {
      // A release stuck after a crash (pending-*) or failed is removed, then installed again (H9).
      const status = await env.helm(['status', RELEASE, '-n', ns, '-o', 'json']).then(o => JSON.parse(o)?.info?.status as string, () => null);
      if (status && (status.startsWith('pending') || status === 'failed')) await env.helm(['uninstall', RELEASE, '-n', ns, '--no-hooks', '--wait', '--timeout', '2m']);
      if (status === 'deployed') return 'done';
      await env.helm(['upgrade', '--install', RELEASE, env.chart, '-n', ns, '--wait=false', '--timeout', '5m'], storeValues(env, row));
      return 'done';
    } },
    { name: 'setup_job', run: async () => {
      const job = await env.k8s.get<{ status?: { succeeded?: number; failed?: number; conditions?: { type: string; status: string; message?: string }[] } }>('Job', ns, `${RELEASE}-setup`);
      if (job?.status?.succeeded) return 'done';
      const failed = job?.status?.conditions?.find(c => c.type === 'Failed' && c.status === 'True');
      if (failed) throw new Error(`the store setup Job failed: ${failed.message ?? 'see its log'}`);
      return { wait: job ? 'setting up WordPress and WooCommerce' : 'the setup Job has not started' };
    } },
    { name: 'mcp_ready', run: async () => {
      const d = await env.k8s.get<{ status?: { availableReplicas?: number } }>('Deployment', ns, `${RELEASE}-mcp`);
      return (d?.status?.availableReplicas ?? 0) >= 1 ? 'done' : { wait: "the store's MCP server is starting" };
    } },
    { name: 'register', run: async () => {
      const secret = await env.k8s.get<{ data?: Record<string, string> }>('Secret', ns, 'store-secrets');
      const token = Buffer.from(secret?.data?.['mcp-token'] ?? '', 'base64').toString();
      if (!token) throw new Error('store-secrets has no mcp-token');
      const url = `http://mcp.${ns}.svc.cluster.local:8080/mcp`;
      const [mine] = await env.db.select().from(upstreams).where(eq(upstreams.managedId, row.id)).limit(1);
      if (!mine) {
        await env.db.insert(upstreams).values({ prefix: row.slug, name: row.title, url, authType: 'bearer', credentialEnc: env.cipher.encrypt(token),
          enabled: true, managedBy: 'store', managedId: row.id }).catch(e => { throw (e as { code?: string }).code === '23505' ? new Error(`the name ${row.slug} is already used by another server`) : e; });
      }
      await env.db.execute(sql`select pg_notify(${REGISTRY_CHANNEL}, 'changed')`);
      return 'done';
    } },
    { name: 'connected', run: async () => {
      const [mine] = await env.db.select({ at: upstreams.toolsCachedAt }).from(upstreams).where(eq(upstreams.managedId, row.id)).limit(1);
      return mine?.at ? 'done' : { wait: 'the gateway has not listed the store\'s tools yet' };
    } },
  ];
}

// Teardown (H8): tools first; then the namespace, which takes the Helm release, the Secret and the
// volumes with it; then wait until it and its volumes are gone.
export function storeTeardown(env: StoreEnv, row: StoreRow): Step<null>[] {
  const ns = storeNamespace(row.slug);
  return [
    { name: 'unregister', run: async () => {
      const [mine] = await env.db.select().from(upstreams).where(eq(upstreams.managedId, row.id)).limit(1);
      if (mine) await deleteUpstream(env.db, mine.prefix, { managed: true });
      return 'done';
    } },
    { name: 'delete_namespace', run: async () => {
      const own = await ownNamespace(env, row).catch(() => undefined);
      if (own && !own.metadata.deletionTimestamp) await env.k8s.delete('Namespace', undefined, ns);
      return 'done';
    } },
    { name: 'namespace_gone', run: async () => {
      const left = await env.k8s.get('Namespace', undefined, ns);
      if (left && left.metadata.annotations?.['urumi.dev/owner-id'] === row.id) return { wait: `namespace ${ns} is terminating` };
      const pvs = await env.k8s.list<{ metadata: { name: string }; spec?: { claimRef?: { namespace?: string } } }>('PersistentVolume');
      const held = pvs.filter(p => p.spec?.claimRef?.namespace === ns).map(p => p.metadata.name);
      return held.length ? { wait: `volumes still being released: ${held.join(', ')}` } : 'done';
    } },
  ];
}
