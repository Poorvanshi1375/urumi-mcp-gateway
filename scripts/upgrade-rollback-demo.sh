#!/usr/bin/env bash
# Upgrade the gateway to a broken image, show that the old pods keep serving, roll back with Helm,
# and count failed requests during the whole thing. Works for the local cluster and the VPS:
#   scripts/upgrade-rollback-demo.sh                                   (local k3d)
#   KUBECONFIG=~/.kube/urumi-vps.yaml GW_URL=https://app.<ip>.nip.io scripts/upgrade-rollback-demo.sh                                 (VPS, through the SSH tunnel)
# Needs the platform release deployed from this repo's chart (same chart version).
set -uo pipefail
cd "$(dirname "$0")/.."
NS=${NS:-urumi}; GW_URL=${GW_URL:-http://localhost:9080}
CHART=infra/helm/urumi-platform
step() { printf '\n==> %s\n' "$*"; }
TMP=$(mktemp -d); trap 'kill $PROBE 2>/dev/null; rm -rf "$TMP"' EXIT

step "before"
helm history platform -n "$NS" | tail -3
GOOD=$(helm history platform -n "$NS" -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s).filter(r=>r.status==="deployed");console.log(h[h.length-1].revision)})')
echo "current good revision: $GOOD"
kubectl get deploy -n "$NS" platform -o jsonpath='image {.spec.template.spec.containers[0].image}, ready {.status.readyReplicas}/{.status.replicas}{"\n"}'

step "a client keeps calling the gateway every 200 ms (counts anything that is not 200)"
( while :; do c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$GW_URL/readyz"); echo "$(date +%s.%N) $c"; sleep 0.2; done ) > "$TMP/probe" &
PROBE=$!

step "upgrade to a broken image (tag does-not-exist); --wait gives up after 90 s"
# --reset-then-reuse-values keeps everything the release was installed with (values files and --set
# host names); only the image tag changes. Passing a values file again would reset those.
helm upgrade platform "$CHART" -n "$NS" --reset-then-reuse-values \
  --set image.tag=does-not-exist --wait --timeout 90s 2>&1 | tail -2
kubectl get pods -n "$NS" -l app=platform -o custom-columns=POD:.metadata.name,READY:.status.containerStatuses[0].ready,WAITING:.status.initContainerStatuses[0].state.waiting.reason,IMAGE:.spec.containers[0].image
helm history platform -n "$NS" | tail -2
[ "$(helm history platform -n "$NS" -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).at(-1).status))')" = failed ] \
  || { echo "the broken upgrade did not reach the cluster: nothing to demonstrate"; exit 1; }
echo "requests so far: $(wc -l < "$TMP/probe"), not 200: $(awk '$2 != 200' "$TMP/probe" | wc -l)"

step "helm rollback platform $GOOD"
helm rollback platform "$GOOD" -n "$NS" --wait --timeout 5m 2>&1 | tail -1
kubectl rollout status -n "$NS" deploy/platform --timeout=180s
sleep 3; kill $PROBE 2>/dev/null; wait $PROBE 2>/dev/null

step "after"
helm history platform -n "$NS" | tail -3
kubectl get deploy -n "$NS" platform -o jsonpath='image {.spec.template.spec.containers[0].image}, ready {.status.readyReplicas}/{.status.replicas}{"\n"}'
total=$(wc -l < "$TMP/probe"); bad=$(awk '$2 != 200' "$TMP/probe" | wc -l)
echo "client requests during upgrade + rollback: $total, not 200: $bad"
[ "$bad" = 0 ] && echo "UPGRADE/ROLLBACK DEMO: no failed requests" || { echo "UPGRADE/ROLLBACK DEMO: $bad failed requests"; awk '$2 != 200' "$TMP/probe" | head -5; }
