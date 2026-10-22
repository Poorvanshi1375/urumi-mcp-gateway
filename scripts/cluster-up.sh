#!/usr/bin/env bash
# Create (or start) the local k3d cluster. Idempotent: an existing cluster is started if stopped
# and otherwise left alone; it is never deleted or recreated.
#
# The cluster: k3s v1.35.5 (same as the VPS), 1 server + 1 agent, Traefik as the Ingress controller,
# local-path storage, and k3s's built-in NetworkPolicy controller (kube-router), so the charts'
# NetworkPolicies are enforced locally. Traefik is published on host port 9080 (8080 is often
# taken on Windows hosts) and the API on 6550.
#
# Local domains: http://store.localhost:9080 (storefront) and http://localhost:9080 (dashboard and
# /mcp). Browsers and curl resolve *.localhost to 127.0.0.1 themselves, so no hosts file is needed.
# Env: CLUSTER, HTTP_PORT, HTTPS_PORT, API_PORT, AGENTS, K3S_IMAGE, NS.
set -euo pipefail
cd "$(dirname "$0")/.."
CLUSTER=${CLUSTER:-urumi-local}
HTTP_PORT=${HTTP_PORT:-9080}; HTTPS_PORT=${HTTPS_PORT:-9443}; API_PORT=${API_PORT:-6550}
AGENTS=${AGENTS:-1}
K3S_IMAGE=${K3S_IMAGE:-rancher/k3s:v1.35.5-k3s1}
NS=${NS:-urumi}

for t in docker k3d kubectl helm node openssl; do command -v $t >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; done
docker info >/dev/null 2>&1 || { echo "Docker is not running (on Windows: start Docker Desktop)" >&2; exit 1; }

if k3d cluster get "$CLUSTER" >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' | grep -qx "k3d-$CLUSTER-server-0"; then
    echo "cluster $CLUSTER exists and is running"
  else
    echo "cluster $CLUSTER exists; starting it"; k3d cluster start "$CLUSTER" --wait
  fi
else
  # Pull on the host first: pulls from inside the k3d nodes are unreliable on Docker Desktop.
  docker image inspect "$K3S_IMAGE" >/dev/null 2>&1 || docker pull "$K3S_IMAGE"
  # --secrets-encryption: Secrets are encrypted at rest in the k3s datastore, as on the VPS.
  k3d cluster create "$CLUSTER" --image "$K3S_IMAGE" --servers 1 --agents "$AGENTS" --api-port "$API_PORT" \
    -p "$HTTP_PORT:80@loadbalancer" -p "$HTTPS_PORT:443@loadbalancer" --k3s-arg "--secrets-encryption@server:*" --wait
fi
kubectl config use-context "k3d-$CLUSTER" >/dev/null

echo "waiting for nodes and Traefik"
kubectl wait --for=condition=Ready node --all --timeout=180s >/dev/null
for i in $(seq 1 90); do kubectl get deploy -n kube-system traefik >/dev/null 2>&1 && break; sleep 2; done
kubectl rollout status -n kube-system deploy/traefik --timeout=300s >/dev/null
# Traefik on the node's ports instead of ServiceLB, as on the VPS (infra/k3s/traefik-hostport.yaml).
# Locally k3d's own load balancer still sits in front, so the gateway sees its address, not yours;
# what this keeps identical is the Traefik setup the VPS runs.
if [ "$(kubectl -n kube-system get svc traefik -o jsonpath='{.spec.type}')" != ClusterIP ]; then
  kubectl apply -f infra/k3s/traefik-hostport.yaml >/dev/null
  for i in $(seq 1 60); do [ "$(kubectl -n kube-system get svc traefik -o jsonpath='{.spec.type}' 2>/dev/null)" = ClusterIP ] && break; sleep 3; done
  kubectl rollout status -n kube-system deploy/traefik --timeout=300s >/dev/null
  echo "Traefik switched to hostPort 80/443"
fi
kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS" >/dev/null

# Third-party images the charts and test pods use, pulled on the host and loaded into every node
# (pulls from inside k3d nodes time out intermittently on Docker Desktop). Skipped when present.
IMAGES=(wordpress:7.1.3-php8.3-apache wordpress:cli-2.12.0-php8.3 mysql:8.4 postgres:18-alpine node:24-alpine busybox:1.37)
for img in "${IMAGES[@]}"; do
  missing=0
  for n in $(docker ps --format '{{.Names}}' | grep -E "^k3d-$CLUSTER-(server|agent)-[0-9]+$"); do
    docker exec "$n" crictl inspecti "docker.io/library/$img" >/dev/null 2>&1 || missing=1
  done
  if [ $missing = 1 ]; then echo "loading $img into the nodes"; CLUSTER=$CLUSTER infra/scripts/k3d-import.sh "$img" >/dev/null; fi
done
echo "images present on all nodes: ${IMAGES[*]}"

kubectl get nodes -o custom-columns=NAME:.metadata.name,STATUS:.status.conditions[-1].type,VERSION:.status.nodeInfo.kubeletVersion --no-headers
echo "storage classes: $(kubectl get storageclass -o jsonpath='{.items[*].metadata.name}')"
echo "ingress: Traefik on http://localhost:$HTTP_PORT (404 on an empty cluster): $(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$HTTP_PORT/")"
echo "cluster $CLUSTER ready; namespace $NS exists. Next: make secrets, then make install."
