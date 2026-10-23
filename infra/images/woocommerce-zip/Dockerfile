# The WooCommerce plugin zip, baked into a small image so a store's setup Job installs it from a file
# instead of downloading it from wordpress.org (faster, and no outside dependency during a demo).
# The download happens here, at build time, and must match the pinned SHA-256 (H6).
# Build: infra/scripts/build-image.sh woocommerce-zip   (the tag follows this file's commits)
FROM alpine:3.22 AS fetch
ARG WOO_VERSION=11.2.1
ARG WOO_SHA256=5317434cb381b5fdc7c1dd6ee258324f08c390976aaf8d1199f2a0e9a3ab8586
RUN wget -q -O /woocommerce.zip "https://downloads.wordpress.org/plugin/woocommerce.${WOO_VERSION}.zip" \
 && echo "${WOO_SHA256}  /woocommerce.zip" | sha256sum -c - \
 && chmod 0444 /woocommerce.zip

FROM busybox:1.37
COPY --from=fetch /woocommerce.zip /plugin/woocommerce.zip
USER 65534
