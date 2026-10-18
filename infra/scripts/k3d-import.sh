#!/usr/bin/env bash
# Import host images into every k3d node's containerd.
# `k3d image import` silently imports nothing on Docker Desktop with the
# containerd image store (multi-platform index, missing non-amd64 blobs),
# so save only linux/amd64 and pipe it into each node.
# Usage: infra/scripts/k3d-import.sh <image> [<image>...]   (CLUSTER=urumi-local)
set -euo pipefail
CLUSTER="${CLUSTER:-urumi-local}"
nodes=$(docker ps --format '{{.Names}}' | grep -E "^k3d-${CLUSTER}-(server|agent)-[0-9]+$")
for img in "$@"; do
  docker image inspect "$img" >/dev/null 2>&1 || docker pull "$img"
  for n in $nodes; do
    echo "importing $img -> $n"
    docker save --platform linux/amd64 "$img" | docker exec -i "$n" ctr -n k8s.io images import - >/dev/null
  done
done
for n in $nodes; do docker exec "$n" crictl images | grep -F -e "$(printf '%s\n' "$@" | sed 's/:.*//' | head -1)" || true; done
