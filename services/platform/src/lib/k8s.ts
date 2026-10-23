// A minimal Kubernetes API client for the provisioner (T1-2/T1-3): plain fetch with the pod's
// service-account token and CA, so no client library is needed. Only what the provisioner uses:
// get, list, server-side apply and delete, each with a timeout. Nothing else in the platform holds
// a Kubernetes token; this module is only loaded by the provisioner.
import { readFileSync, statSync } from 'node:fs';
import { Agent } from 'undici';

export type K8sObject = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; [k: string]: unknown }; [k: string]: unknown };

export class K8sError extends Error {
  status: number;
  reason: string;
  constructor(status: number, reason: string, message: string) { super(message); this.status = status; this.reason = reason; }
}

// kind -> [API group path, plural, namespaced]. Only the kinds the provisioner creates or reads.
const KINDS: Record<string, [string, string, boolean]> = {
  Namespace: ['api/v1', 'namespaces', false],
  PersistentVolume: ['api/v1', 'persistentvolumes', false],
  Secret: ['api/v1', 'secrets', true],
  ConfigMap: ['api/v1', 'configmaps', true],
  Service: ['api/v1', 'services', true],
  ServiceAccount: ['api/v1', 'serviceaccounts', true],
  PersistentVolumeClaim: ['api/v1', 'persistentvolumeclaims', true],
  ResourceQuota: ['api/v1', 'resourcequotas', true],
  LimitRange: ['api/v1', 'limitranges', true],
  Pod: ['api/v1', 'pods', true],
  Event: ['api/v1', 'events', true],
  Deployment: ['apis/apps/v1', 'deployments', true],
  StatefulSet: ['apis/apps/v1', 'statefulsets', true],
  Job: ['apis/batch/v1', 'jobs', true],
  NetworkPolicy: ['apis/networking.k8s.io/v1', 'networkpolicies', true],
  Ingress: ['apis/networking.k8s.io/v1', 'ingresses', true],
  RoleBinding: ['apis/rbac.authorization.k8s.io/v1', 'rolebindings', true],
};

const NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

// The API path of one object, or of a collection when name is omitted. Names are checked here, so a
// value from a database row can never add path segments or a query string.
export function resourcePath(kind: string, namespace?: string, name?: string): string {
  const k = KINDS[kind];
  if (!k) throw new Error(`unsupported kind ${kind}`);
  const [group, plural, namespaced] = k;
  for (const v of [namespace, name]) if (v !== undefined && !NAME_RE.test(v)) throw new Error(`invalid Kubernetes name "${v}"`);
  if (namespaced && !namespace) throw new Error(`${kind} needs a namespace`);
  return `/${group}${namespaced ? `/namespaces/${namespace}` : ''}/${plural}${name ? `/${name}` : ''}`;
}

export type K8sOptions = {
  baseUrl: string;                  // https://<host>:<port>
  token: () => string;              // read on every call (projected tokens rotate)
  fetch?: typeof fetch;             // replaceable in tests
  timeoutMs?: number;
  fieldManager?: string;
};

export class K8sClient {
  private o: Required<Omit<K8sOptions, 'fetch'>> & { fetch: typeof fetch };
  constructor(o: K8sOptions) {
    // Defaults with ??, not a spread: an option passed as undefined must not erase its default.
    this.o = { baseUrl: o.baseUrl, token: o.token, fetch: o.fetch ?? fetch, timeoutMs: o.timeoutMs ?? 10_000, fieldManager: o.fieldManager ?? 'urumi-provisioner' };
  }

  private async request(method: string, path: string, body?: string, contentType?: string): Promise<any> {
    const res = await this.o.fetch(`${this.o.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.o.token()}`, accept: 'application/json', ...(contentType ? { 'content-type': contentType } : {}) },
      body,
      signal: AbortSignal.timeout(this.o.timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new K8sError(res.status, data?.reason ?? `HTTP ${res.status}`, String(data?.message ?? `${method} ${path} -> HTTP ${res.status}`).slice(0, 500));
    return data;
  }

  // undefined when the object does not exist.
  async get<T = K8sObject>(kind: string, namespace: string | undefined, name: string): Promise<T | undefined> {
    try { return await this.request('GET', resourcePath(kind, namespace, name)); }
    catch (e) { if (e instanceof K8sError && e.status === 404) return undefined; throw e; }
  }

  async list<T = K8sObject>(kind: string, namespace?: string, labelSelector?: string): Promise<T[]> {
    const q = labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : '';
    return (await this.request('GET', `${resourcePath(kind, namespace)}${q}`)).items ?? [];
  }

  // Server-side apply: create or update to exactly this desired state (fields we own), the same on
  // every run, so a step can be repeated after a crash. JSON is valid YAML for the apply patch type.
  async apply<T = K8sObject>(obj: K8sObject): Promise<T> {
    const { kind, metadata } = obj;
    const path = `${resourcePath(kind, metadata.namespace, metadata.name)}?fieldManager=${encodeURIComponent(this.o.fieldManager)}&force=true`;
    return this.request('PATCH', path, JSON.stringify(obj), 'application/apply-patch+yaml');
  }

  // true when it was deleted (or is being deleted), false when it did not exist. A namespace that
  // is already terminating counts as deleted: deleting it again succeeds without any admission
  // check running, so callers must not read success as "the fence allowed it" (P0 spike).
  async delete(kind: string, namespace: string | undefined, name: string): Promise<boolean> {
    try { await this.request('DELETE', resourcePath(kind, namespace, name), JSON.stringify({ propagationPolicy: 'Foreground' }), 'application/json'); return true; }
    catch (e) { if (e instanceof K8sError && e.status === 404) return false; throw e; }
  }
}

// The client for the pod this runs in: API address from the environment, token and CA from the
// projected service-account volume. The token file is re-read at most once a minute.
export function inClusterClient(o: { fetch?: typeof fetch; timeoutMs?: number } = {}): K8sClient {
  const dir = '/var/run/secrets/kubernetes.io/serviceaccount';
  const host = process.env.KUBERNETES_SERVICE_HOST, port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) throw new Error('not running in a Kubernetes pod (KUBERNETES_SERVICE_HOST is not set)');
  const dispatcher = new Agent({ connect: { ca: readFileSync(`${dir}/ca.crt`) } });
  let cached = { token: '', at: 0, mtime: 0 };
  const token = () => {
    const now = Date.now();
    if (now - cached.at > 60_000) {
      const mtime = statSync(`${dir}/token`).mtimeMs;
      if (mtime !== cached.mtime || !cached.token) cached = { token: readFileSync(`${dir}/token`, 'utf8').trim(), at: now, mtime };
      else cached.at = now;
    }
    return cached.token;
  };
  const viaCa: typeof fetch = (url, init) => (o.fetch ?? fetch)(url, { ...init, dispatcher } as RequestInit);
  return new K8sClient({ baseUrl: `https://${host.includes(':') ? `[${host}]` : host}:${port}`, token, fetch: viaCa, timeoutMs: o.timeoutMs });
}
