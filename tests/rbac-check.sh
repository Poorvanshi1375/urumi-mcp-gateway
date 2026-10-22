#!/usr/bin/env bash
# The provisioner's fence, on a live cluster (P4; from the P0 spike): what its service account can and
# cannot do with the RBAC and admission policies the chart renders (provisioner.enabled). Acts as the
# provisioner through impersonation. Creates and removes only the namespaces store-vdodrb, mcp-vdodrb
# (as the provisioner), vdod-victim and store-vdodot (as the admin, as stand-in targets).
# Usage: NS=urumi tests/rbac-check.sh
set -uo pipefail
NS=${NS:-urumi}
SA=platform-provisioner
TENANT=urumi-tenant-operator-$NS
OK_IMG=docker.io/library/urumi-ship-mcp:check
AS=(--as=system:serviceaccount:$NS:$SA)
pass=0; fail=0
ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1"; fail=$((fail+1)); }
# expect allow|deny <name> <command...>; deny output must mention the reason pattern in $WHY when set
expect() {
  local want=$1 name=$2; shift 2
  local out; out=$("$@" 2>&1); local rc=$?
  if [[ $want == allow && $rc == 0 ]]; then ok "$name"
  elif [[ $want == deny && $rc != 0 ]]; then ok "$name  ($(echo "$out" | tr '\n' ' ' | grep -oE '(ValidatingAdmissionPolicy|forbidden|violates PodSecurity)[^.]*' | head -1 | cut -c1-110))"
  else bad "$name  (rc=$rc: $(echo "$out" | tr '\n' ' ' | cut -c1-200))"; fi
}
# denyfor <reason-regex> <name> <command...>: denied, and for the expected reason (no vacuous passes)
denyfor() {
  local why=$1 name=$2; shift 2
  local out; out=$("$@" 2>&1); local rc=$?
  if [[ $rc != 0 ]] && echo "$out" | grep -qE "$why"; then ok "$name  ($(echo "$out" | tr '\n' ' ' | grep -oE "$why" | head -1))"
  else bad "$name  (rc=$rc: $(echo "$out" | tr '\n' ' ' | cut -c1-220))"; fi
}
ns_yaml() { # name managed-label? pss platform-label (empty: none)
  local platform=${4-$NS}
  cat <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: $1
  labels:
$( [[ $2 == yes ]] && echo "    urumi.dev/managed-by: urumi-provisioner" )
$( [[ -n $platform ]] && echo "    urumi.dev/platform: $platform" )
    pod-security.kubernetes.io/enforce: ${3:-restricted}
EOF
}
NSS="store-vdodrb mcp-vdodrb vdod-victim store-vdodot"
cleanup() {
  kubectl delete ns $NSS --ignore-not-found --wait=false >/dev/null 2>&1
}
trap cleanup EXIT

# A previous run's namespaces may still be terminating: wait until they are gone.
kubectl wait --for=delete $(printf 'ns/%s ' $NSS) --timeout=120s >/dev/null 2>&1
for n in $NSS; do kubectl get ns "$n" >/dev/null 2>&1 && { echo "leftover namespace $n still present; stop"; exit 1; }; done
kubectl get sa -n "$NS" "$SA" >/dev/null 2>&1 || { echo "no provisioner service account $NS/$SA: is provisioner.enabled on?"; exit 1; }
kubectl create ns vdod-victim >/dev/null   # an unmanaged namespace made by the admin, as a stand-in target
# Another install's tenant namespace (made by the admin): managed, but platform "other".
kubectl create -f <(ns_yaml store-vdodot yes restricted other) >/dev/null

echo "--- RBAC (kubectl auth can-i)"
expect deny  "cannot read Secrets in urumi"              kubectl auth can-i get secrets -n "$NS" "${AS[@]}" --quiet
expect deny  "cannot list Secrets cluster-wide"          kubectl auth can-i list secrets -A "${AS[@]}" --quiet
expect deny  "cannot create pods in urumi"               kubectl auth can-i create pods -n "$NS" "${AS[@]}" --quiet
expect deny  "cannot create ClusterRoleBindings"         kubectl auth can-i create clusterrolebindings "${AS[@]}" --quiet
expect deny  "cannot create Roles anywhere"              kubectl auth can-i create roles -n vdod-victim "${AS[@]}" --quiet
expect deny  "cannot bind cluster-admin"                 kubectl auth can-i bind clusterroles/cluster-admin "${AS[@]}" --quiet
expect allow "can bind only the tenant-operator role"    kubectl auth can-i bind clusterroles/$TENANT "${AS[@]}" --quiet
expect deny  "cannot impersonate"                        kubectl auth can-i impersonate users "${AS[@]}" --quiet

echo "--- namespaces (VAP)"
denyfor "names?.*mcp-<prefix>" "cannot create kube-foo"                    kubectl create "${AS[@]}" -f <(ns_yaml kube-foo yes)
expect deny  "cannot create store-x without the label"   kubectl create "${AS[@]}" -f <(ns_yaml store-nol no)
expect deny  "cannot create with Pod Security privileged" kubectl create "${AS[@]}" -f <(ns_yaml store-prv yes privileged)
denyfor "urumi.dev/platform=$NS" "cannot create without the platform label (H3a)" kubectl create "${AS[@]}" -f <(ns_yaml store-npl yes restricted "")
denyfor "urumi.dev/platform=$NS" "cannot create with another install's label (H3a)" kubectl create "${AS[@]}" -f <(ns_yaml store-opl yes restricted other)
expect allow "can create store-vdodrb"                      kubectl create "${AS[@]}" -f <(ns_yaml store-vdodrb yes)
denyfor "only change or delete namespaces it manages for this install" "cannot delete another install's namespace (H3a)" kubectl delete ns store-vdodot "${AS[@]}" --wait=false
denyfor "urumi.dev/platform=$NS" "cannot drop the platform label (H3a)" kubectl label ns store-vdodrb urumi.dev/platform- "${AS[@]}"
denyfor "only change or delete namespaces it manages" "cannot delete an unmanaged namespace"      kubectl delete ns vdod-victim "${AS[@]}" --wait=false
expect deny  "cannot label an unmanaged namespace as managed" kubectl label ns vdod-victim urumi.dev/managed-by=urumi-provisioner "${AS[@]}"
expect deny  "cannot remove the managed label (escape the fence)" kubectl label ns store-vdodrb urumi.dev/managed-by- "${AS[@]}"
expect deny  "cannot lower Pod Security to privileged"   kubectl label ns store-vdodrb pod-security.kubernetes.io/enforce=privileged --overwrite "${AS[@]}"
kubectl get ns vdod-victim >/dev/null 2>&1 && ok "vdod-victim still exists" || bad "vdod-victim was deleted"

echo "--- role bindings (RBAC bind + VAP)"
rb() { # ns role subject name
  cat <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ${4:-urumi-provisioner}, namespace: $1 }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: $2 }
subjects: [{ kind: ServiceAccount, name: ${3:-$SA}, namespace: $NS }]
EOF
}
denyfor "forbidden|only the tenant-operator" "cannot bind cluster-admin in its namespace" kubectl create "${AS[@]}" -f <(rb store-vdodrb cluster-admin)
expect deny  "cannot bind tenant-operator to another SA"  kubectl create "${AS[@]}" -f <(rb store-vdodrb $TENANT default)
expect deny  "cannot bind in an unmanaged namespace"      kubectl create "${AS[@]}" -f <(rb vdod-victim $TENANT)
denyfor "must be named urumi-provisioner" "cannot use another binding name (H3c)" kubectl create "${AS[@]}" -f <(rb store-vdodrb $TENANT $SA extra)
expect allow "can bind tenant-operator to itself in store-vdodrb" kubectl create "${AS[@]}" -f <(rb store-vdodrb $TENANT)

echo "--- every namespaced write goes to this install's namespaces (H3b)"
# The admin binds the tenant role in an unmanaged and in another install's namespace, so RBAC would
# allow the provisioner there: only the namespaced-writes policy stops it.
kubectl create -f <(rb vdod-victim $TENANT) >/dev/null && kubectl create -f <(rb store-vdodot $TENANT) >/dev/null
kubectl auth can-i create configmaps -n store-vdodot "${AS[@]}" --quiet && ok "precondition: RBAC allows the write in store-vdodot" || bad "precondition: RBAC binding in store-vdodot missing"
denyfor "not store-vdodot" "cannot write in another install's namespace (H3b)" kubectl create configmap x -n store-vdodot --from-literal=a=1 --dry-run=server "${AS[@]}"
denyfor "not vdod-victim" "cannot write in an unmanaged namespace (H3b)" kubectl create configmap x -n vdod-victim --from-literal=a=1 --dry-run=server "${AS[@]}"
denyfor "not store-vdodot" "cannot delete in another install's namespace (H3b)" kubectl delete rolebinding urumi-provisioner -n store-vdodot "${AS[@]}"
expect allow "can write in its own namespace (dry run)"   kubectl create configmap x -n store-vdodrb --from-literal=a=1 --dry-run=server "${AS[@]}"

echo "--- workloads in store-vdodrb (VAP + Pod Security)"
dep() { # name pod-spec-extra container-securityContext [namespace] [image]
  local sc=${3:-} ns=${4:-store-vdodrb} image=${5:-busybox:1.36}
  [[ -z $sc ]] && sc='{ allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }'
  cat <<EOF
apiVersion: apps/v1
kind: Deployment
metadata: { name: $1, namespace: $ns }
spec:
  replicas: 1
  selector: { matchLabels: { app: $1 } }
  template:
    metadata: { labels: { app: $1 } }
    spec:
      automountServiceAccountToken: false
      securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
${2:-}
      containers:
        - name: c
          image: $image
          securityContext: $sc
EOF
}
dep okdep | kubectl create --dry-run=client -f - -o name >/dev/null && ok "manifest builder renders a valid Deployment" || bad "manifest builder broken"
expect  allow "can create a restricted Deployment (dry run)"  kubectl create --dry-run=server "${AS[@]}" -f <(dep okdep)
denyfor "no host namespaces, hostPath or privileged containers" "cannot create a privileged Deployment" kubectl create --dry-run=server "${AS[@]}" -f <(dep privdep "" "{ privileged: true }")
denyfor "no host namespaces, hostPath or privileged containers" "cannot mount hostPath"       kubectl create --dry-run=server "${AS[@]}" -f <(dep hostdep "      volumes: [{ name: h, hostPath: { path: / } }]")
denyfor "no host namespaces, hostPath or privileged containers" "cannot use hostNetwork"      kubectl create --dry-run=server "${AS[@]}" -f <(dep netdep "      hostNetwork: true")
denyfor "cannot create resource \"pods\""                         "cannot create bare pods (RBAC)" kubectl run p --image=busybox:1.36 -n store-vdodrb --dry-run=server "${AS[@]}"
denyfor "only ClusterIP Services" "cannot create a NodePort Service"           kubectl create service nodeport np --tcp=80:80 -n store-vdodrb --dry-run=server "${AS[@]}"
expect allow "can create a ClusterIP Service (dry run)"   kubectl create service clusterip cip --tcp=80:80 -n store-vdodrb --dry-run=server "${AS[@]}"
denyfor "cannot (get|patch) resource \"deployments\"" "cannot touch the urumi namespace's Deployments" kubectl scale deploy/platform -n "$NS" --replicas=0 "${AS[@]}" --dry-run=server

echo "--- image allowlist at admission in mcp-* (H4)"
expect allow "can create mcp-vdodrb"                         kubectl create "${AS[@]}" -f <(ns_yaml mcp-vdodrb yes)
expect allow "can bind itself in mcp-vdodrb"                 kubectl create "${AS[@]}" -f <(rb mcp-vdodrb $TENANT)
SC='{ allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }'
INIT_BAD="      initContainers: [{ name: i, image: docker.io/library/busybox:1.36, securityContext: $SC }]"
expect allow "allowed image runs (dry run)"               kubectl create --dry-run=server "${AS[@]}" -f <(dep okimg "" "" mcp-vdodrb $OK_IMG)
denyfor "image not on the allowlist: docker.io/library/busybox:1.36" "a non-allowed image is refused" kubectl create --dry-run=server "${AS[@]}" -f <(dep badimg "" "" mcp-vdodrb docker.io/library/busybox:1.36)
denyfor "image not on the allowlist: urumi-ship-mcp:check" "the short form of an allowed image is refused" kubectl create --dry-run=server "${AS[@]}" -f <(dep shortimg "" "" mcp-vdodrb urumi-ship-mcp:check)
denyfor "image not on the allowlist: docker.io/library/busybox:1.36" "a non-allowed init container is refused" kubectl create --dry-run=server "${AS[@]}" -f <(dep initimg "$INIT_BAD" "" mcp-vdodrb $OK_IMG)
denyfor "image not on the allowlist: docker.io.evil.com" "a look-alike registry is refused" kubectl create --dry-run=server "${AS[@]}" -f <(dep evilimg "" "" mcp-vdodrb docker.io.evil.com/library/urumi-x:1)
expect allow "store namespaces are not limited by it (dry run)" kubectl create --dry-run=server "${AS[@]}" -f <(dep storeimg "" "" store-vdodrb docker.io/library/busybox:1.36)

echo "--- teardown"
expect allow "can delete its own namespaces"              kubectl delete ns store-vdodrb mcp-vdodrb "${AS[@]}" --wait=false
[ $fail = 0 ] && echo "RBAC CHECK PASSED ($pass)" || echo "RBAC CHECK FAILED ($fail of $((pass + fail)))"
exit $((fail > 0))
