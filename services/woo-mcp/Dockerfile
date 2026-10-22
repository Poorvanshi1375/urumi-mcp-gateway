# WooCommerce MCP server (cluster-internal). Node 24 runs the .ts sources directly (type stripping).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
# The package managers are not needed once dependencies are installed (the containers only run
# node), and they carry their own bundled packages that scanners flag (npm's undici and
# brace-expansion in node:24-alpine). Removing them leaves a scan nothing of theirs to flag (the
# image size is unchanged: they live in a base-image layer).
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
