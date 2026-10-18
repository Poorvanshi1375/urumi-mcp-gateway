#!/usr/bin/env bash
# Build services/<name> as image urumi-<name>:<tag> and import it into k3d.
# The tag is the last git commit touching the image's sources (+ "-dirty-<epoch>" with uncommitted
# changes there), so IfNotPresent never reuses a stale image. The platform image also bundles the
# dashboard, so it is built from services/ and its tag covers both directories.
# Usage: infra/scripts/build-image.sh <name>    Prints the tag on the last line.
set -euo pipefail
name="${1:?usage: build-image.sh <service-name>}"
cd "$(dirname "$0")/../.."
dir="services/$name"
[ -f "$dir/Dockerfile" ] || { echo "no $dir/Dockerfile" >&2; exit 1; }
if [ "$name" = platform ]; then srcs=(services/platform services/dashboard); context=services; else srcs=("$dir"); context="$dir"; fi
tag="$(git log -1 --format=%h -- "${srcs[@]}")"
[ -n "$tag" ] || tag=uncommitted
git diff --quiet HEAD -- "${srcs[@]}" 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard "${srcs[@]}")" ] \
  || tag="${tag}-dirty-$(date +%s)"
img="urumi-${name}:${tag}"
docker build -q -t "$img" -f "$dir/Dockerfile" "$context" >/dev/null
infra/scripts/k3d-import.sh "$img" >/dev/null
echo "$tag"
