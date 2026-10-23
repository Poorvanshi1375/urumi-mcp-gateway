# The provisioner's image (T1-2/T1-3): the platform image (same code; it runs src/provisioner.ts)
# plus Helm, to install the urumi-store chart for bonus stores, and that chart. The gateway image
# stays without Helm. Helm is pinned by digest (the same 3.22.1 as CI's helm lint).
# Build: infra/scripts/build-image.sh provisioner   (context: the repository root; see the
# .dockerignore next to this file, which sends only the store chart)
ARG PLATFORM_IMAGE
FROM alpine/helm:3.22.1@sha256:8191701ad1f82ee3695c87211fcbfe6d7b1bb7df92ac1c8de9ccdb0995a6a2c1 AS helm

FROM ${PLATFORM_IMAGE}
COPY --from=helm /usr/bin/helm /usr/local/bin/helm
COPY --chown=root:root infra/helm/urumi-store /app/charts/urumi-store
# Helm's cache and config live under /tmp (an emptyDir: the root filesystem is read-only).
ENV HELM_CACHE_HOME=/tmp/helm/cache HELM_CONFIG_HOME=/tmp/helm/config HELM_DATA_HOME=/tmp/helm/data
USER node
