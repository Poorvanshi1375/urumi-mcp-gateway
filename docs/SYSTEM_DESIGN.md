# System design and tradeoffs

How the gateway is built and why, and what changes for production. Security is covered in [THREAT_MODEL.md](THREAT_MODEL.md).

## 1. Architecture choices

**One platform service, not three.** The MCP gateway (`/mcp`), the dashboard API (`/api`), the chat agent and the React build are one Node 24 process (Fastify 5, MCP TypeScript SDK v2). They share one in-process gateway core, so an MCP client and the chat agent cannot take different paths. One origin also means no CORS, one Ingress host and a strict Content-Security-Policy. It runs as 2 or more replicas.

**The gateway core.** `services/platform/src/gateway/mcp.ts` exposes two functions that every entry point uses:
- `listToolsFor(principal)`: tools of enabled, connected servers, minus tools the caller's role may not use, minus tools waiting for re-approval (tool pinning);
- `callAsUser(principal, source, name, args)`: resolve the name, check permission, route with a timeout, write one audit row, update metrics.

`/mcp` builds a fresh stateless MCP server per request on top of these; the chat agent calls them directly with the signed-in user as principal. Permissions, timeouts and audit therefore live in exactly one place.

**Postgres for all shared state.** Users, sessions (hashed), API keys (SHA-256 only), registered servers (credential encrypted with AES-256-GCM), tool permissions, tool pins, the audit log, the activity log and sign-in throttling. Replicas keep only caches and re-read on `NOTIFY` (registry, permissions, pins, re-check requests). Schema changes are Drizzle migrations applied by an init container under an advisory lock.

**Our own MCP servers speak only to what they need.** woo-mcp calls the WooCommerce REST API v3 with OAuth 1.0a signatures over plain HTTP inside the cluster (WooCommerce only accepts key and secret as Basic auth over HTTPS, so in-cluster calls must be signed; the signature covers the store's configured home URL, so that URL is a value per environment). REST gives a stable, versioned contract with WooCommerce's own validation, and woo-mcp needs no access to WordPress's files or database. ship-mcp is a small deterministic shipping service whose `get_order` deliberately collides with woo-mcp's.

**Two Helm charts, one namespace.** `urumi-store` (WordPress, MySQL, setup Job) and `urumi-platform` (gateway, Postgres, our MCP servers). Separate releases mean a gateway rollback can never touch the store's data. Isolation inside the namespace comes from NetworkPolicies on pod labels, not namespace boundaries.

**Secrets outside Helm.** `scripts/secrets.sh` creates every Secret; the charts reference them by name. No secret value is in git, in values files or in Helm's release history.

## 2. Tool aggregation and routing

1. **Registry.** Servers live in Postgres: prefix (2 to 12 lowercase letters or digits, unique), URL, auth type (none, bearer, custom header) and encrypted credential. Our two servers and DeepWiki are registered on first start; admins add more in the dashboard.
2. **Connections.** The gateway is an MCP client with one pooled connection per server (Streamable HTTP). It adds the server's own credential, decrypted only at that moment. The client's API key is never sent upstream.
3. **Health loop.** Every 5 s (local) or 10 s (VPS) each server is listed independently, with at most one check in flight per server, so a slow server delays nobody. The result is cached in memory and in Postgres, so `tools/list` never waits on an upstream.
4. **Naming.** Each tool is exposed as `<prefix>__<name>`. Names keep only `[A-Za-z0-9_-]` and at most 64 characters (what strict LLM providers accept); a name that has to be cut, or collides after cleaning, gets an 8-character hash suffix. A per-server map from exposed name to the upstream's own name is used to route back. Descriptions are cleaned of control and bidi characters and capped at 1024 characters, and each is prefixed with `[Server name]`.
5. **Collisions.** Because of the prefix, `woo__get_order` and `ship__get_order` coexist; the prefix is the documented scheme, and routing splits on the first `__` (tool names may contain `__` themselves).
6. **Routing a call.** `callAsUser` splits the name, finds the server's state, maps the exposed name back, checks the caller's permission, and calls the upstream with a 20 s timeout. Results over 100,000 characters are cut, with a note. One audit row is written whatever happens.
7. **Change propagation.** Disabling a server, changing a permission or approving a tool writes to Postgres and sends `NOTIFY`. Each replica reloads and sends `tools/list_changed` to its connected clients; Claude Code re-lists within about a second. The chat agent reads the tool list per message.

**Tool search mode** (feature flag): for many servers, `/mcp?mode=search` exposes only `gateway__search_tools` (keyword ranking of the caller's own tools) and `gateway__call_tool` (the same `callAsUser` path).

## 3. Failure handling

| Situation | What happens |
|---|---|
| A server is slow | Its call times out after 20 s with "Server X did not answer within 20 s"; health checks time out after 8 s. Other servers' calls and `tools/list` are unaffected (independent checks, cached lists). Tested with a 25 s artificial delay: woo answered in about 100 ms meanwhile. |
| A server dies | The next health check fails. Refused connections, unknown hosts, auth failures and connect timeouts to in-cluster addresses mark it Unreachable at once; other errors need two failures in a row, so a single network blip (common with remote servers) does not hide its tools. Its tools leave `tools/list`; calls fail in milliseconds with the reason. The replica that notices tells the others through `NOTIFY` so they re-check at once. |
| A server comes back | The next health check reconnects and its tools return; clients get `tools/list_changed`. |
| A pod is killed | Its Deployment replaces it, usually before the next health check. Stopping the server entirely (0 replicas) shows Unreachable within one health interval (measured 8 to 16 s on the VPS). |
| A call fails mid-way | `isError: true` result with a one-line reason, audited as `tool_error`, `timeout` or `upstream_unreachable`. A failed call also triggers an immediate health check. |
| Postgres is down | Readiness fails and Traefik stops routing to the gateway; calls already routed finish. The gateway reconnects its `LISTEN` connection when Postgres returns. |
| A gateway replica is replaced | Rolling updates wait for readiness; a `preStop` pause lets Traefik stop routing first; a PodDisruptionBudget keeps one replica. Measured: no failed requests during a broken-image upgrade and rollback. |
| An upstream changes a tool definition | With tool pinning on, the changed tool is hidden and refused until an admin approves the new version. |

On k3s we measured something local k3d hides: after a Service's last pod disappears, new connections to it are dropped (not refused) for 20 s or more. The connect-timeout rule for in-cluster servers and short-lived upstream sockets exist because of that.

## 4. Scaling

`/mcp` keeps no session state, so any replica can serve any request; this was tested with MCP Inspector and Claude Code, each of which was served by both replicas. Replicas run their own health checks and synchronise registry, permission, pin and health changes through Postgres `NOTIFY`, converging in about a second. Rate limits (120 requests per minute per key, burst 60; 10 chat messages per minute per user) are per replica, so a key can get up to N times the rate with N replicas; an exact limit would need Redis. Sign-in throttling is in Postgres and therefore exact.

## 5. What changes for production

| Area | Local | Production-like VPS | Real production |
|---|---|---|---|
| DNS and hosts | `*.localhost` | `*.<ip>.nip.io` | a real domain; set `store.host`, `store.homeUrl`, `platform.ingress.host` |
| Ingress and TLS | Traefik, plain HTTP | Traefik, Let's Encrypt via cert-manager, http redirected to https | same, or the cloud's load balancer and certificates |
| Storage class | `local-path` (node disk) | `local-path` (instance disk; terminating the instance loses data) | a replicated or cloud block storage class, backups of MySQL and Postgres |
| Secrets | `scripts/secrets.sh` | `scripts/secrets.sh` on the node | External Secrets from a vault, or sealed-secrets; the charts only need Secrets with the right keys |
| Images | built and loaded into k3d | copied over SSH | a registry (for example GHCR) with pinned tags |
| Gateway replicas | 2 | HPA 2 to 4 | same, plus pod anti-affinity across nodes |
| Databases | single Postgres and MySQL pods | same | managed databases or replicated charts |
| Rate limits and caches | per replica | per replica | Redis for exact shared limits |
| Metrics | `/metrics` on a private port | same | scraped by Prometheus (`networkPolicy.metricsScrapers`), dashboards in Grafana |

## 6. Known limits

- The first version of a server's tools is trusted (tool pinning starts from it), and tool results are only capped and delimited, not reviewed.
- Rate limits are per replica (see above).
- Members can see every server's name and tool list (not URLs or credentials).
- 2025-revision MCP clients (Inspector, Cursor) see tool-list changes on their next list, not by push; calls are still refused at once.
- One WooCommerce store; the multi-store bonus was not attempted.
