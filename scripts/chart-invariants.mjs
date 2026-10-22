// Checks the rendered Helm charts, with no cluster: both charts, with values-local.yaml and
// values-prod.yaml. The brief's "probes, requests and limits on every workload" and our own rules
// become a test that runs before anything is deployed (and in CI):
//   - every workload: readiness and liveness probes (not Jobs), CPU and memory requests and limits
//     on every container, the pod security rules of scripts/lib/pod-security.mjs (non-root, no
//     escalation, capabilities dropped, seccomp, no API token);
//   - no Secret objects: every Secret comes from scripts/secrets.sh, never from Helm;
//   - Services of the databases and MCP servers are ClusterIP, and no Ingress routes to them;
//   - each chart has a default-deny NetworkPolicy for its release;
//   - egress into the provisioner's namespaces reaches only their MCP pod (urumi.dev/role=mcp) of
//     this install, and no egress rule selects every namespace;
//   - RBAC (the provisioner, P4): no role grants "*", escalate or impersonate, and bind only with
//     resourceNames; every ClusterRoleBinding binds only the provisioner's account, to a role
//     without Secrets (no cluster-wide Secret access); no RoleBinding is rendered (the tenant
//     binding is made per namespace at run time); each admission policy fails closed, denies,
//     matches only the provisioner, and all five are there.
// Run: node scripts/chart-invariants.mjs            (needs helm; uses services/platform's yaml package)
//      node scripts/chart-invariants.mjs --self-test (breaks a render on purpose and expects failures)
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isProvisioner, podSecurityProblems } from './lib/pod-security.mjs';

const require = createRequire(new URL('../services/platform/package.json', import.meta.url));
const YAML = require('yaml');
const root = new URL('..', import.meta.url).pathname;

// The values each environment gets on the command line (as in the Makefile and deploy-ec2.sh).
const IMAGES = ['--set', 'image.tag=check', '--set', 'wooMcp.image.tag=check', '--set', 'shipMcp.image.tag=check'];
const RENDERS = [
  { chart: 'urumi-store', values: 'values-local.yaml', set: [] },
  { chart: 'urumi-store', values: 'values-prod.yaml', set: ['--set', 'store.host=store.203.0.113.10.nip.io', '--set', 'store.homeUrl=https://store.203.0.113.10.nip.io'] },
  { chart: 'urumi-platform', values: 'values-local.yaml', set: IMAGES },
  { chart: 'urumi-platform', values: 'values-prod.yaml', set: [...IMAGES, '--set', 'platform.ingress.host=app.203.0.113.10.nip.io', '--set', 'wooMcp.store.signingBaseUrl=http://store.203.0.113.10.nip.io'] },
  // With the provisioner on (hosted servers, bonus stores): its objects and rules are checked too.
  { chart: 'urumi-platform', values: 'values-local.yaml', set: [...IMAGES, '--set', 'provisioner.enabled=true'], label: 'provisioner on' },
];
const INTERNAL = /mysql|postgres|mcp/;   // workloads that must never be reachable from outside

export function render({ chart, values, set }) {
  const out = execFileSync('helm', ['template', chart === 'urumi-store' ? 'store' : 'platform', `${root}infra/helm/${chart}`, '-n', 'urumi',
    '-f', `${root}infra/helm/${chart}/${values}`, ...set], { encoding: 'utf8' });
  return YAML.parseAllDocuments(out).map(d => d.toJS()).filter(Boolean);
}

export function problems(docs) {
  const bad = [];
  for (const d of docs) {
    const id = `${d.kind}/${d.metadata?.name}`;
    if (d.kind === 'Secret') bad.push(`${id}: Secret rendered by Helm (create it with scripts/secrets.sh)`);
    const spec = d.kind === 'CronJob' ? d.spec?.jobTemplate?.spec?.template?.spec : ['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(d.kind) ? d.spec?.template?.spec : null;
    if (spec) {
      const job = d.kind === 'Job' || d.kind === 'CronJob';
      for (const c of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
        const r = c.resources ?? {};
        if (!r.requests?.cpu || !r.requests?.memory || !r.limits?.cpu || !r.limits?.memory) bad.push(`${id}/${c.name}: requests and limits`);
      }
      if (!job) for (const c of spec.containers ?? []) if (!c.readinessProbe || !c.livenessProbe) bad.push(`${id}/${c.name}: readiness and liveness probes`);
      // Exactly one workload may hold a token: the provisioner's Deployment, named like its account.
      const tokenAllowed = d.kind === 'Deployment' && isProvisioner(d.spec?.template?.metadata?.labels, spec) && spec.serviceAccountName === d.metadata.name;
      bad.push(...podSecurityProblems(id, spec, { tokenAllowed }));
    }
    if (d.kind === 'Service' && INTERNAL.test(d.metadata.name) && (d.spec?.type ?? 'ClusterIP') !== 'ClusterIP') bad.push(`${id}: type ${d.spec.type}, must be ClusterIP`);
    if (d.kind === 'Ingress') {
      for (const rule of d.spec?.rules ?? []) for (const p of rule.http?.paths ?? []) {
        if (INTERNAL.test(p.backend?.service?.name ?? '')) bad.push(`${id}: routes ${rule.host ?? '*'} to ${p.backend.service.name}`);
      }
    }
  }
  // The gateway must refuse its own public names as upstreams (idea B): every Ingress host of the
  // render is on its SSRF deny list.
  const ingressHosts = docs.filter(d => d.kind === 'Ingress').flatMap(d => (d.spec?.rules ?? []).map(r => r.host).filter(Boolean));
  for (const d of docs) for (const c of d.spec?.template?.spec?.containers ?? []) {
    const deny = c.env?.find(e => e.name === 'SSRF_DENY_HOSTS');
    if (!deny) continue;
    const listed = String(deny.value ?? '').split(',');
    for (const h of ingressHosts) if (!listed.includes(h)) bad.push(`${d.kind}/${d.metadata.name}/${c.name}: SSRF_DENY_HOSTS lacks its own Ingress host ${h}`);
  }
  for (const d of docs.filter(x => x.kind === 'NetworkPolicy')) for (const e of d.spec?.egress ?? []) for (const t of e.to ?? []) {
    const id = `NetworkPolicy/${d.metadata.name}`;
    if (t.namespaceSelector && !Object.keys(t.namespaceSelector.matchLabels ?? {}).length && !(t.namespaceSelector.matchExpressions ?? []).length) bad.push(`${id}: egress to every namespace (empty namespaceSelector)`);
    const ns = t.namespaceSelector?.matchLabels ?? {};
    if (!('urumi.dev/managed-by' in ns)) continue;
    if (t.podSelector?.matchLabels?.['urumi.dev/role'] !== 'mcp' || !ns['urumi.dev/platform']) bad.push(`${id}: egress into managed namespaces must select only the urumi.dev/role=mcp pods of this install`);
    if ((e.ports ?? []).some(x => (x.port ?? 0) < 1024)) bad.push(`${id}: egress into managed namespaces on a port below 1024`);
  }
  bad.push(...rbacProblems(docs));
  const denyAll = docs.some(d => d.kind === 'NetworkPolicy' && d.spec?.podSelector?.matchLabels?.['app.kubernetes.io/instance'] && !d.spec.ingress && d.spec.policyTypes?.includes('Ingress'));
  if (!denyAll) bad.push('no default-deny NetworkPolicy for the release');
  return bad;
}

const VAPS = ['namespaces', 'namespaced-writes', 'rolebindings', 'workloads', 'images'];
function rbacProblems(docs) {
  const bad = [];
  const roles = docs.filter(d => d.kind === 'ClusterRole' || d.kind === 'Role');
  for (const r of roles) for (const rule of r.rules ?? []) {
    const id = `${r.kind}/${r.metadata.name}`;
    if ((rule.verbs ?? []).includes('*') || (rule.resources ?? []).includes('*') || (rule.apiGroups ?? []).includes('*')) bad.push(`${id}: grants "*"`);
    if ((rule.verbs ?? []).some(v => v === 'escalate' || v === 'impersonate')) bad.push(`${id}: grants ${rule.verbs.join(',')}`);
    if ((rule.verbs ?? []).includes('bind') && !(rule.resourceNames ?? []).length) bad.push(`${id}: bind without resourceNames (could bind any role)`);
  }
  const provisionerSAs = docs.filter(d => d.kind === 'ServiceAccount' && /-provisioner$/.test(d.metadata.name)).map(d => `${d.metadata.namespace}/${d.metadata.name}`);
  for (const b of docs.filter(d => d.kind === 'ClusterRoleBinding')) {
    const id = `ClusterRoleBinding/${b.metadata.name}`;
    for (const s of b.subjects ?? []) if (s.kind !== 'ServiceAccount' || !provisionerSAs.includes(`${s.namespace}/${s.name}`)) bad.push(`${id}: binds ${s.kind} ${s.namespace ?? ''}/${s.name}, not the provisioner`);
    const role = roles.find(r => r.kind === 'ClusterRole' && r.metadata.name === b.roleRef?.name);
    if (!role) bad.push(`${id}: binds ClusterRole ${b.roleRef?.name}, not one this chart renders`);
    else if ((role.rules ?? []).some(rule => (rule.resources ?? []).includes('secrets'))) bad.push(`${id}: Secrets cluster-wide (ClusterRole ${role.metadata.name})`);
  }
  for (const b of docs.filter(d => d.kind === 'RoleBinding')) bad.push(`RoleBinding/${b.metadata.name}: rendered by the chart (the tenant binding is made per namespace by the provisioner)`);
  const vaps = docs.filter(d => d.kind === 'ValidatingAdmissionPolicy'), bindings = docs.filter(d => d.kind === 'ValidatingAdmissionPolicyBinding');
  for (const v of vaps) {
    const id = `ValidatingAdmissionPolicy/${v.metadata.name}`;
    if (v.spec?.failurePolicy !== 'Fail') bad.push(`${id}: failurePolicy ${v.spec?.failurePolicy}, must be Fail`);
    if (!(v.spec?.matchConditions ?? []).some(m => /request\.userInfo\.username == "system:serviceaccount:[^"]+-provisioner"/.test(m.expression))) bad.push(`${id}: does not match only the provisioner`);
    const b = bindings.find(x => x.spec?.policyName === v.metadata.name);
    if (!b || JSON.stringify(b.spec.validationActions) !== '["Deny"]') bad.push(`${id}: no binding with validationActions [Deny]`);
  }
  // The provisioner's egress: DNS, Postgres and the Kubernetes API port only, never the internet.
  for (const np of docs.filter(d => d.kind === 'NetworkPolicy' && /-provisioner$/.test(d.metadata.name))) for (const e of np.spec?.egress ?? []) {
    const ports = (e.ports ?? []).map(p => p.port);
    if (ports.some(p => ![53, 5432, 6443].includes(p))) bad.push(`NetworkPolicy/${np.metadata.name}: provisioner egress on port ${ports.join(',')} (only DNS, Postgres and the API server's 6443)`);
    if (!e.to && !ports.every(p => p === 6443)) bad.push(`NetworkPolicy/${np.metadata.name}: provisioner egress to any address on ${ports.join(',')}`);
  }
  if (provisionerSAs.length) for (const n of VAPS) if (!vaps.some(v => v.metadata.name.endsWith(`-${n}`))) bad.push(`provisioner: admission policy "${n}" missing`);
  return bad;
}

const workloads = docs => docs.filter(d => ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(d.kind)).length;

function main() {
  if (process.argv.includes('--self-test')) {
    // Break one render in the ways the rules exist for; every break must be reported.
    const docs = render(RENDERS[2]);
    const gw = docs.find(d => d.kind === 'Deployment' && d.metadata.name === 'platform');
    delete gw.spec.template.spec.containers[0].livenessProbe;
    gw.spec.template.spec.automountServiceAccountToken = true;
    gw.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation = true;
    delete gw.spec.template.spec.containers[0].resources.limits;
    docs.find(d => d.kind === 'Service' && /mcp/.test(d.metadata.name)).spec.type = 'NodePort';
    docs.push({ kind: 'Secret', metadata: { name: 'leaked' } });
  for (const e of gw.spec.template.spec.containers[0].env) if (e.name === 'SSRF_DENY_HOSTS') e.value = '';
    const found = problems(docs);
    const want = ['livenessProbe|liveness', 'service-account token', 'privilege escalation', 'requests and limits', 'must be ClusterIP', 'Secret rendered', 'lacks its own Ingress host'];
    // The provisioner's egress rule: drop its pod selector (tenant MySQL and WordPress reachable),
    // and add a rule to every namespace.
    const prov = render(RENDERS.find(r => r.label === 'provisioner on'));
    const gwNp = prov.find(d => d.kind === 'NetworkPolicy' && d.spec?.egress?.some(e => e.to?.some(t => t.namespaceSelector?.matchLabels?.['urumi.dev/managed-by'])));
    delete gwNp.spec.egress.find(e => e.to?.some(t => t.namespaceSelector?.matchLabels?.['urumi.dev/managed-by'])).to[0].podSelector;
    gwNp.spec.egress.push({ to: [{ namespaceSelector: {} }] });
    // The provisioner's fence, broken six ways.
    const nsRole = prov.find(d => d.kind === 'ClusterRole' && /^urumi-provisioner-/.test(d.metadata.name));
    nsRole.rules.push({ apiGroups: [''], resources: ['secrets'], verbs: ['get'] });
    delete nsRole.rules.find(r => r.verbs.includes('bind')).resourceNames;
    prov.push({ kind: 'ClusterRoleBinding', metadata: { name: 'tenant-everywhere' }, roleRef: { name: prov.find(d => d.kind === 'ClusterRole' && /tenant-operator/.test(d.metadata.name)).metadata.name }, subjects: [{ kind: 'Group', name: 'system:authenticated' }] });
    prov.find(d => d.kind === 'ValidatingAdmissionPolicy' && /-namespaces$/.test(d.metadata.name)).spec.failurePolicy = 'Ignore';
    prov.find(d => d.kind === 'ValidatingAdmissionPolicyBinding' && /-workloads$/.test(d.metadata.name)).spec.validationActions = ['Audit'];
    prov.splice(prov.findIndex(d => d.kind === 'ValidatingAdmissionPolicy' && /-images$/.test(d.metadata.name)), 1);
    prov.find(d => d.kind === 'NetworkPolicy' && /-provisioner$/.test(d.metadata.name)).spec.egress.push({ ports: [{ port: 443, protocol: 'TCP' }] });
    found.push(...problems(prov));
    want.push('only the urumi.dev/role=mcp pods', 'every namespace', 'Secrets cluster-wide', 'bind without resourceNames', 'not the provisioner', 'failurePolicy Ignore', 'validationActions \\[Deny\\]', 'admission policy "images" missing', 'provisioner egress on port 443');
    const missed = want.filter(w => !found.some(f => new RegExp(w).test(f)));
    console.log(missed.length ? `SELF-TEST FAILED: not detected: ${missed.join(', ')}` : `SELF-TEST PASSED: all ${want.length} breaks detected`);
    process.exit(missed.length ? 1 : 0);
  }

  let failed = 0;
  for (const r of RENDERS) {
    const docs = render(r);
    const bad = problems(docs);
    if (bad.length) failed++;
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${`${r.chart} ${r.values}${r.label ? ` (${r.label})` : ''}`.padEnd(36)} ${bad.length ? bad.join('; ') : `${docs.length} objects, ${workloads(docs)} workloads`}`);
  }
  console.log(failed ? 'CHART INVARIANTS FAILED' : 'CHART INVARIANTS PASSED');
  process.exit(failed ? 1 : 0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
