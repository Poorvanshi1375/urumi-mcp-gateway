#!/usr/bin/env bash
# The gateway's egress into the provisioner's namespaces (P3), on a live cluster: it may reach only
# the MCP pod (urumi.dev/role=mcp) of a namespace this install manages, on ports 1024 and up, and
# nothing else there: not a tenant's database or WordPress, and nothing in another install's
# namespaces. Two stand-in tenant namespaces are made by the admin (not the provisioner) and removed
# at the end; their pods are busybox httpd on 8080, and the MCP pod also on 80.
# Usage: NS=urumi tests/tenant-egress-check.sh
set -uo pipefail
NS=${NS:-urumi}
OURS=mcp-vdodnp OTHER=mcp-vdodot
fails=0
pass() { echo "PASS  $1  $2"; }
fail() { echo "FAIL  $1  $2"; fails=$((fails+1)); }
cleanup() { kubectl delete ns "$OURS" "$OTHER" --ignore-not-found --wait=false >/dev/null 2>&1; }
trap cleanup EXIT
kubectl wait --for=delete "ns/$OURS" "ns/$OTHER" --timeout=120s >/dev/null 2>&1

pod() { # namespace name labels ports
  local cmd=""; for p in $4; do cmd="$cmd httpd -p $p -h /tmp;"; done
  kubectl run "$2" -n "$1" --labels="$3" --restart=Never --image=busybox:1.37 \
    --overrides='{"spec":{"containers":[{"name":"'"$2"'","image":"busybox:1.37","command":["sh","-c","'"$cmd"' sleep 600"],"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"100m","memory":"32Mi"}}}]}}' >/dev/null
}
for n in "$OURS:$NS" "$OTHER:some-other-install"; do
  kubectl create ns "${n%%:*}" >/dev/null && kubectl label ns "${n%%:*}" urumi.dev/managed-by=urumi-provisioner "urumi.dev/platform=${n#*:}" vdod=nptest >/dev/null
  pod "${n%%:*}" mcp "urumi.dev/role=mcp" "8080 80"
  pod "${n%%:*}" db "app=mysql" "8080"
done
for n in "$OURS" "$OTHER"; do kubectl wait pod --all -n "$n" --for=condition=Ready --timeout=120s >/dev/null; done
sleep 8   # kube-router adds a new pod's IP to the allow sets a few seconds after it starts
ip() { kubectl get pod -n "$1" "$2" -o jsonpath='{.status.podIP}'; }
reach() { kubectl exec -n "$NS" deploy/platform -c platform -- node -e '
  const s = require("net").connect({ host: process.argv[1], port: Number(process.argv[2]), timeout: 3000 }, () => { console.log("REACHABLE"); s.destroy(); });
  s.on("timeout", () => { console.log("BLOCKED"); s.destroy(); }); s.on("error", e => console.log(e.code === "ECONNREFUSED" ? "REFUSED" : "BLOCKED"));' "$1" "$2" 2>/dev/null; }
# kube-router rejects denied traffic, which looks like "nothing listening" (REFUSED); so every target
# is first reached from inside its own namespace (no policy there): that proves it is listening, and
# a refusal from the gateway is then the policy's.
listening() { kubectl exec -n "$1" mcp -- nc -w 3 -z "$2" "$3" >/dev/null 2>&1; }
check() { # name want namespace ip port
  local r; listening "$3" "$4" "$5" || { fail "gateway -> $1" "control failed: nothing listening at $4:$5"; return; }
  r=$(reach "$4" "$5"); [ "$r" = REFUSED ] && r=BLOCKED
  [ "$r" = "$2" ] && pass "gateway -> $1" "$r (listening: yes, from inside its namespace)" || fail "gateway -> $1" "${r:-no result} (want $2)"
}
check "this install's tenant MCP pod :8080"    REACHABLE "$OURS" "$(ip "$OURS" mcp)" 8080
check "this install's tenant MCP pod :80"      BLOCKED   "$OURS" "$(ip "$OURS" mcp)" 80
check "this install's tenant database pod"     BLOCKED   "$OURS" "$(ip "$OURS" db)" 8080
check "another install's tenant MCP pod"       BLOCKED   "$OTHER" "$(ip "$OTHER" mcp)" 8080
check "another install's tenant database pod"  BLOCKED   "$OTHER" "$(ip "$OTHER" db)" 8080
[ $fails = 0 ] && echo "TENANT EGRESS CHECK PASSED" || echo "TENANT EGRESS CHECK FAILED ($fails)"
exit $((fails > 0))
