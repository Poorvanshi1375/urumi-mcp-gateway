// Security rules for a pod spec, shared by the live check (verify-dod.sh pipes `kubectl get pods -o
// json` in) and the offline check of rendered charts (scripts/chart-invariants.mjs):
//   every container (init containers too): non-root, no privilege escalation, all capabilities
//   dropped, seccomp RuntimeDefault; every pod: no Kubernetes API token mounted, except the
//   provisioner's (the one component that calls the API; isProvisioner says which pod that is).
// As a script it prints "OK <summary>" or "BAD <problems>".
import { pathToFileURL } from 'node:url';

// The provisioner's pod: its component label, and its own service account named <release>-provisioner
// (the account the chart binds to its ClusterRoles). Nothing else may hold a token.
export const isProvisioner = (labels, spec) => labels?.['app.kubernetes.io/component'] === 'provisioner' && /-provisioner$/.test(spec?.serviceAccountName ?? '');

// Problems with one pod spec; `id` names the pod in the messages. opts.tokenAllowed: this is the
// provisioner (isProvisioner), which alone may mount a token.
export function podSecurityProblems(id, spec, opts = {}) {
  const bad = [];
  const ps = spec.securityContext ?? {};
  const token = spec.automountServiceAccountToken !== false || (spec.volumes ?? []).some(v => v.projected?.sources?.some(x => x.serviceAccountToken));
  if (token && !opts.tokenAllowed) bad.push(`${id}: mounts a service-account token`);
  for (const c of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
    const cs = c.securityContext ?? {};
    const cid = `${id}/${c.name}`;
    const nonRoot = (cs.runAsNonRoot ?? ps.runAsNonRoot) === true && (cs.runAsUser ?? ps.runAsUser ?? 1) !== 0;
    if (!nonRoot) bad.push(`${cid}: may run as root`);
    if (cs.allowPrivilegeEscalation !== false) bad.push(`${cid}: privilege escalation allowed`);
    if (!(cs.capabilities?.drop ?? []).includes('ALL')) bad.push(`${cid}: capabilities not dropped`);
    if ((cs.seccompProfile ?? ps.seccompProfile)?.type !== 'RuntimeDefault') bad.push(`${cid}: no seccomp profile`);
  }
  return bad;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let s = '';
  process.stdin.on('data', d => (s += d)).on('end', () => {
    const bad = [];
    let n = 0, ro = 0, pods = 0, holders = 0;
    for (const p of JSON.parse(s).items) {
      if (p.metadata.labels?.vdod) continue;   // verify-dod's own probe pods
      pods++;
      const id = p.metadata.name.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$|-[a-z0-9]{5}$/, '');
      const tokenAllowed = isProvisioner(p.metadata.labels, p.spec);
      if (tokenAllowed) holders++;
      bad.push(...podSecurityProblems(id, p.spec, { tokenAllowed }));
      for (const c of [...(p.spec.initContainers ?? []), ...p.spec.containers]) { n++; if (c.securityContext?.readOnlyRootFilesystem) ro++; }
    }
    console.log(bad.length ? `BAD ${[...new Set(bad)].join(', ')}` : `OK ${n} containers, ${ro} with a read-only root filesystem; ${pods} pods, ${holders ? `only the provisioner (${holders}) with an API token` : 'none with an API token'}`);
  });
}
