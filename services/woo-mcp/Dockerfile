# WooCommerce MCP server (cluster-internal). Node 24 runs the .ts sources directly (type stripping).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
