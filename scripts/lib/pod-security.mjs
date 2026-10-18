// Reads `kubectl get pods -o json` on stdin and checks every container (init containers too):
// non-root, no privilege escalation, all capabilities dropped, seccomp RuntimeDefault.
// Prints "OK <summary>" or "BAD <problems>". Used by scripts/verify-dod.sh.
let s = '';
process.stdin.on('data', d => (s += d)).on('end', () => {
  const bad = [];
  let n = 0, ro = 0;
  for (const p of JSON.parse(s).items) {
    if (p.metadata.labels?.vdod) continue;   // verify-dod's own probe pods
    const ps = p.spec.securityContext ?? {};
    for (const c of [...(p.spec.initContainers ?? []), ...p.spec.containers]) {
      n++;
      const cs = c.securityContext ?? {};
      const id = `${p.metadata.name.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$|-[a-z0-9]{5}$/, '')}/${c.name}`;
      const nonRoot = (cs.runAsNonRoot ?? ps.runAsNonRoot) === true && (cs.runAsUser ?? ps.runAsUser ?? 1) !== 0;
      if (!nonRoot) bad.push(`${id}: may run as root`);
      if (cs.allowPrivilegeEscalation !== false) bad.push(`${id}: privilege escalation allowed`);
      if (!(cs.capabilities?.drop ?? []).includes('ALL')) bad.push(`${id}: capabilities not dropped`);
      if ((cs.seccompProfile ?? ps.seccompProfile)?.type !== 'RuntimeDefault') bad.push(`${id}: no seccomp profile`);
      if (cs.readOnlyRootFilesystem) ro++;
    }
  }
  console.log(bad.length ? `BAD ${[...new Set(bad)].join(', ')}` : `OK ${n} containers, ${ro} with a read-only root filesystem`);
});
