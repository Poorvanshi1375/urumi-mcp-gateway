# Urumi platform image: the Fastify gateway + dashboard API (CMD), the DB migrations (run by the
# pod's init container: node src/db/migrate.ts) and the built dashboard (/app/public).
# Build context: services/  (infra/scripts/build-image.sh platform)

FROM node:24-alpine AS dashboard
WORKDIR /build
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/ ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DASHBOARD_DIR=/app/public
# Node's happy-eyeballs gives each address only 250 ms to connect. Remote upstreams such as
# DeepWiki (AWS us-west, ~280-400 ms TCP connect from India) then fail with ETIMEDOUT (V5).
ENV NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000
COPY platform/package.json platform/package-lock.json ./
# The package managers are not needed once dependencies are installed (the containers only run
# node), and they carry their own bundled packages that scanners flag (npm's undici and
# brace-expansion in node:24-alpine). Removing them leaves a scan nothing of theirs to flag (the
# image size is unchanged: they live in a base-image layer).
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY platform/drizzle ./drizzle
COPY platform/src ./src
COPY --from=dashboard /build/dist ./public
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
