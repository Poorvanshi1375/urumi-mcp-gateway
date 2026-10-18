#!/usr/bin/env bash
# Set ship-mcp's SIMULATED_LATENCY_MS (test knob for gateway timeouts) and wait until no pod with
# the old setting is left. `rollout status` returns while the old pod is still in its preStop
# pause, and the gateway's kept-alive connection can still reach it.
# Usage: tests/ship-latency.sh <ms>      (NS, default urumi)
set -euo pipefail
NS=${NS:-urumi}; MS=${1:?usage: ship-latency.sh <ms>}
old=$(kubectl get pod -n "$NS" -l app=ship-mcp,app.kubernetes.io/instance=platform -o name)
kubectl set env -n "$NS" deploy/platform-ship-mcp SIMULATED_LATENCY_MS="$MS" >/dev/null
kubectl rollout status -n "$NS" deploy/platform-ship-mcp --timeout=120s >/dev/null
[ -n "$old" ] && kubectl wait -n "$NS" --for=delete $old --timeout=90s >/dev/null 2>&1 || true
echo "ship-mcp latency ${MS} ms; old pod gone"
