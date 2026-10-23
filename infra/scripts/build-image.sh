#!/usr/bin/env bash
# Build services/<name> (or infra/images/<name>) as image urumi-<name>:<tag> and import it into k3d.
# The tag is the last git commit touching the image's sources (+ "-dirty-<epoch>" with uncommitted
# changes there), so IfNotPresent never reuses a stale image. The platform image also bundles the
# dashboard, so it is built from services/ and its tag covers both directories. The provisioner
# image is the platform image plus Helm and the store chart: built from the repository root, its
# tag covers all of those, and it builds the platform image first.
# Usage: infra/scripts/build-image.sh <name>    Prints the tag on the last line.
set -euo pipefail
name="${1:?usage: build-image.sh <service-name>}"
cd "$(dirname "$0")/../.."
dir="services/$name"; [ -d "$dir" ] || dir="infra/images/$name"
[ -f "$dir/Dockerfile" ] || { echo "no services/$name/Dockerfile or infra/images/$name/Dockerfile" >&2; exit 1; }
args=()
case $name in
  platform) srcs=(services/platform services/dashboard); context=services ;;
  provisioner)
    srcs=(services/platform services/dashboard infra/helm/urumi-store "$dir"); context=.
    args=(--build-arg "PLATFORM_IMAGE=urumi-platform:$(infra/scripts/build-image.sh platform | tail -1)") ;;
  *) srcs=("$dir"); context="$dir" ;;
esac
tag="$(git log -1 --format=%h -- "${srcs[@]}")"
[ -n "$tag" ] || tag=uncommitted
git diff --quiet HEAD -- "${srcs[@]}" 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard "${srcs[@]}")" ] \
  || tag="${tag}-dirty-$(date +%s)"
img="urumi-${name}:${tag}"
# A clean tag names exactly these sources: an image already built for it is reused (no registry
# lookups, so a flaky network cannot fail an unchanged build). Dirty tags are always rebuilt.
if [[ $tag != *-dirty-* && $tag != uncommitted* ]] && docker image inspect "$img" >/dev/null 2>&1; then
  infra/scripts/k3d-import.sh "$img" >/dev/null
  echo "$tag"; exit 0
fi
docker build -q -t "$img" "${args[@]}" -f "$dir/Dockerfile" "$context" >/dev/null
infra/scripts/k3d-import.sh "$img" >/dev/null
echo "$tag"
