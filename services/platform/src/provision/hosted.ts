// A hosted MCP server (stand-out 5): an admin's container image, run by the provisioner in its own
// namespace mcp-<prefix> and registered as a managed upstream. The objects are built here and
// server-side applied (idempotent, like every step); there is no Helm release to track, because
// teardown deletes the whole namespace (H8). A server is ready when the gateway has connected to it
// and listed its tools (H7): the provisioner never calls the tenant pod.
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { REGISTRY_CHANNEL } from '../db/client.ts';
import { hostedServers, upstreams } from '../db/schema.ts';
import type { CredentialCipher } from '../lib/crypto.ts';
import { checkImage } from '../lib/image-ref.ts';
import type { K8sClient, K8sObject } from '../lib/k8s.ts';
import { deleteUpstream } from '../services/upstreams.ts';
import type { Step } from './steps.ts';

export type HostedRow = typeof hostedServers.$inferSelect;
export type HostedEnv = {
  db: Db; k8s: K8sClient; cipher: CredentialCipher;
  releaseNamespace: string;     // the platform's namespace: the platform label, and the gateway's home
  releaseName: string;          // the gateway pods' app.kubernetes.io/instance
  serviceAccount: string;       // the provisioner's own account (the tenant role binding's subject)
  tenantRole: string;           // the ClusterRole bound in each tenant namespace
  allowedImages: string[];
};

export const SIZES: Record<string, { cpu: string; memory: string }> = {
  small: { cpu: '100m', memory: '128Mi' }, medium: { cpu: '250m', memory: '256Mi' }, large: { cpu: '500m', memory: '512Mi' },
};
export const hostedNamespace = (prefix: string) => `mcp-${prefix}`;
const RUN_AS = 1000;   // a numeric user, so runAsNonRoot can be checked for any image (node images: uid 1000)
// Private, CGNAT, link-local and other non-public ranges: "needs internet" never includes the cluster.
const NOT_PUBLIC = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '127.0.0.0/8', '0.0.0.0/8', '224.0.0.0/4', '240.0.0.0/4'];

const labels = (env: HostedEnv) => ({ 'urumi.dev/managed-by': 'urumi-provisioner', 'urumi.dev/platform': env.releaseNamespace, 'urumi.dev/kind': 'hosted' });

// The namespace is ours only if it carries this row's id: never adopt one made by someone else.
async function ownNamespace(env: HostedEnv, row: HostedRow): Promise<K8sObject | undefined> {
  const ns = await env.k8s.get('Namespace', undefined, hostedNamespace(row.prefix));
  if (ns && ns.metadata.annotations?.['urumi.dev/owner-id'] !== row.id) throw new Error(`namespace ${hostedNamespace(row.prefix)} exists and is not ours`);
  return ns;
}

export function hostedSteps(env: HostedEnv, row: HostedRow): Step<null>[] {
  const ns = hostedNamespace(row.prefix);
  const size = SIZES[row.size] ?? SIZES.small;
  const meta = (name: string) => ({ name, namespace: ns, labels: labels(env) });
  const apply = async (obj: K8sObject) => { await env.k8s.apply(obj); return 'done' as const; };
  return [
    { name: 'image', run: async () => {
      if (row.transport !== 'http') throw new Error(`transport ${row.transport} is not supported yet (only http)`);
      checkImage(row.image, env.allowedImages);   // again: the allowlist may have changed since the row was made
      return 'done';
    } },
    { name: 'namespace', run: async () => {
      await ownNamespace(env, row);
      return apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, annotations: { 'urumi.dev/owner-id': row.id },
        labels: { ...labels(env), 'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/warn': 'restricted', 'pod-security.kubernetes.io/audit': 'restricted' } } });
    } },
    { name: 'rolebinding', run: () => apply({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: meta('urumi-provisioner'),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: env.tenantRole },
      subjects: [{ kind: 'ServiceAccount', name: env.serviceAccount, namespace: env.releaseNamespace }] } as K8sObject) },
    { name: 'quota', run: async () => {
      const twice = (q: string) => q.replace(/^(\d+)/, n => String(Number(n) * 2));   // room for a rolling update
      await env.k8s.apply({ apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta('tenant'), spec: { hard: {
        pods: '3', 'requests.cpu': twice(size.cpu), 'limits.cpu': twice(size.cpu), 'requests.memory': twice(size.memory), 'limits.memory': twice(size.memory),
        persistentvolumeclaims: '0', 'services.loadbalancers': '0', 'services.nodeports': '0' } } } as K8sObject);
      return apply({ apiVersion: 'v1', kind: 'LimitRange', metadata: meta('tenant'), spec: { limits: [{ type: 'Container', default: size, defaultRequest: size }] } } as K8sObject);
    } },
    { name: 'network', run: async () => {
      await env.k8s.apply({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta('default-deny'),
        spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] } } as K8sObject);
      await env.k8s.apply({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta('from-gateway'),
        spec: { podSelector: { matchLabels: { 'urumi.dev/role': 'mcp' } }, policyTypes: ['Ingress'], ingress: [{
          from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': env.releaseNamespace } }, podSelector: { matchLabels: { app: 'platform', 'app.kubernetes.io/instance': env.releaseName } } }],
          ports: [{ port: row.port, protocol: 'TCP' }] }] } } as K8sObject);
      const egress: unknown[] = [{ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
        ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] }];
      if (row.needsInternet) egress.push({ to: [{ ipBlock: { cidr: '0.0.0.0/0', except: NOT_PUBLIC } }], ports: [{ port: 443, protocol: 'TCP' }, { port: 80, protocol: 'TCP' }] });
      return apply({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta('egress'),
        spec: { podSelector: {}, policyTypes: ['Egress'], egress } } as K8sObject);
    } },
    { name: 'secret', run: async () => {
      // The bearer token is made once and kept: re-running the step must not lock the gateway out.
      const existing = await env.k8s.get<{ data?: Record<string, string> }>('Secret', ns, 'hosted-env');
      const token = existing?.data?.MCP_BEARER_TOKEN ? Buffer.from(existing.data.MCP_BEARER_TOKEN, 'base64').toString() : randomBytes(32).toString('base64url');
      const secretEnv = row.secretEnvEnc ? JSON.parse(env.cipher.decrypt(row.secretEnvEnc)) as Record<string, string> : {};
      const data = Object.fromEntries(Object.entries({ ...secretEnv, MCP_BEARER_TOKEN: token }).map(([k, v]) => [k, Buffer.from(String(v)).toString('base64')]));
      return apply({ apiVersion: 'v1', kind: 'Secret', metadata: meta('hosted-env'), type: 'Opaque', data } as K8sObject);
    } },
    { name: 'workload', run: async () => {
      const image = checkImage(row.image, env.allowedImages).full;   // in full, as the image admission policy expects
      const plainEnv = Object.entries((row.env ?? {}) as Record<string, string>).map(([name, value]) => ({ name, value: String(value) }));
      await env.k8s.apply({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta('mcp'), spec: {
        replicas: 1, selector: { matchLabels: { 'urumi.dev/role': 'mcp' } },
        template: { metadata: { labels: { 'urumi.dev/role': 'mcp', ...labels(env) } }, spec: {
          automountServiceAccountToken: false, enableServiceLinks: false,
          securityContext: { runAsNonRoot: true, runAsUser: RUN_AS, runAsGroup: RUN_AS, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{ name: 'mcp', image, imagePullPolicy: 'IfNotPresent',
            env: [...plainEnv, { name: 'PORT', value: String(row.port) }], envFrom: [{ secretRef: { name: 'hosted-env' } }],
            ports: [{ name: 'mcp', containerPort: row.port }],
            readinessProbe: { tcpSocket: { port: row.port }, periodSeconds: 5 }, livenessProbe: { tcpSocket: { port: row.port }, initialDelaySeconds: 15, periodSeconds: 20 },
            resources: { requests: size, limits: size },
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }] }],
          volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }] } } } } as K8sObject);
      return apply({ apiVersion: 'v1', kind: 'Service', metadata: meta('mcp'), spec: { type: 'ClusterIP', selector: { 'urumi.dev/role': 'mcp' }, ports: [{ name: 'mcp', port: row.port, targetPort: row.port }] } } as K8sObject);
    } },
    { name: 'pods_ready', run: async () => {
      const d = await env.k8s.get<{ status?: { availableReplicas?: number } }>('Deployment', ns, 'mcp');
      return (d?.status?.availableReplicas ?? 0) >= 1 ? 'done' : { wait: '0 of 1 pods available' };
    } },
    { name: 'register', run: async () => {
      const secret = await env.k8s.get<{ data?: Record<string, string> }>('Secret', ns, 'hosted-env');
      const token = Buffer.from(secret?.data?.MCP_BEARER_TOKEN ?? '', 'base64').toString();
      if (!token) throw new Error('hosted-env has no MCP_BEARER_TOKEN');
      const url = `http://mcp.${ns}.svc.cluster.local:${row.port}${row.path}`;
      const [mine] = await env.db.select().from(upstreams).where(eq(upstreams.managedId, row.id)).limit(1);
      if (mine) {
        if (mine.url !== url) await env.db.update(upstreams).set({ url, credentialEnc: env.cipher.encrypt(token), updatedAt: new Date() }).where(eq(upstreams.id, mine.id));
      } else {
        // A server registered by URL under this prefix is invisible here (row-level security) and
        // shows up as a unique violation: the API checks prefixes across all three tables first.
        await env.db.insert(upstreams).values({ prefix: row.prefix, name: row.name, url, authType: 'bearer', credentialEnc: env.cipher.encrypt(token),
          enabled: true, managedBy: 'hosted', managedId: row.id }).catch(e => { throw (e as { code?: string }).code === '23505' ? new Error(`prefix ${row.prefix} is already used by another server`) : e; });
      }
      await env.db.execute(sql`select pg_notify(${REGISTRY_CHANNEL}, 'changed')`);
      return 'done';
    } },
    // H7: ready when the gateway has connected and listed the tools (it caches them on the row).
    { name: 'connected', run: async () => {
      const [mine] = await env.db.select({ at: upstreams.toolsCachedAt }).from(upstreams).where(eq(upstreams.managedId, row.id)).limit(1);
      return mine?.at ? 'done' : { wait: 'the gateway has not listed its tools yet' };
    } },
  ];
}

// Teardown (H8): tools first, then the namespace (with everything in it), then wait until it is gone.
export function hostedTeardown(env: HostedEnv, row: HostedRow): Step<null>[] {
  const ns = hostedNamespace(row.prefix);
  return [
    { name: 'unregister', run: async () => {
      const [mine] = await env.db.select().from(upstreams).where(eq(upstreams.managedId, row.id)).limit(1);
      if (mine) await deleteUpstream(env.db, mine.prefix, { managed: true });
      return 'done';
    } },
    { name: 'delete_namespace', run: async () => {
      const own = await ownNamespace(env, row).catch(() => undefined);   // not ours: leave it alone
      if (own && !own.metadata.deletionTimestamp) await env.k8s.delete('Namespace', undefined, ns);
      return 'done';
    } },
    { name: 'namespace_gone', run: async () => {
      const left = await env.k8s.get('Namespace', undefined, ns);
      return left && left.metadata.annotations?.['urumi.dev/owner-id'] === row.id ? { wait: `namespace ${ns} is terminating` } : 'done';
    } },
  ];
}

// The last Warning event in the namespace, for a timed-out step ("Back-off pulling image ...").
export async function lastWarning(env: HostedEnv, row: HostedRow): Promise<string | null> {
  const events = await env.k8s.list<{ type?: string; reason?: string; message?: string; lastTimestamp?: string; eventTime?: string }>('Event', hostedNamespace(row.prefix)).catch(() => []);
  const w = events.filter(e => e.type === 'Warning').sort((a, b) => String(a.lastTimestamp ?? a.eventTime).localeCompare(String(b.lastTimestamp ?? b.eventTime))).at(-1);
  return w ? `${w.reason}: ${w.message}`.slice(0, 200) : null;
}
