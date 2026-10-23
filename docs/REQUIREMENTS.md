# Requirements and where they are proven

Every line of the assignment, the code that implements it, the check that proves it, and where the demo video shows it. Checks run with `make verify` (`scripts/verify-dod.sh`; suites in `services/platform/test/`), `make verify-all` (also the chat, hosted-server, malicious-server and store suites), or offline (`node scripts/chart-invariants.mjs`, `node scripts/values-diff.mjs`, CI). "dod-check: …" names a check printed by `services/platform/test/dod-check.mjs`, and so on.

The video column is filled in after recording.

## Definition of done (two users)

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Storefront: add to cart, check out with cash on delivery | `infra/helm/urumi-store/files/setup.sh` (the setup Job enables cash on delivery) | verify-dod: "storefront /shop/ responds", "WooCommerce REST (Store API) responds"; an order is placed through the Store API when the store has none | |
| The order is visible in WooCommerce admin | the store's wp-admin | verify-dod: "wp-admin login page"; `woo__get_order` returns it (dod-check) | |
| User A: chat creates a product with a name and price; it appears on the storefront | `services/platform/src/chat/agent.ts`, `services/woo-mcp/src/tools.ts` (`create_product`) | chat-check: "C: confirm runs it once, audited (D2 mechanism)" | |
| User A: order it by hand, ask what came in today | `woo__list_orders` with `created_on: "today"` in the store's timezone | chat-check: "orders on a day -> woo__list_orders (C1, D3)" | |
| User B: an external client with only the gateway URL and B's key | `services/platform/src/gateway/mcp.ts`, `gateway/auth.ts` | clients-check (MCP Inspector and Claude Code over the replicas) | |
| User B sees every enabled server's tools and asks the same question | `gateway/upstream-manager.ts` | dod-check: "member tools/list has namespaced tools of each server", "member: \"orders today\" via woo__list_orders" | |
| One prompt needs tools from two servers | woo and ship | dod-check: "member: latest order from woo, then its shipment from ship"; clients-check (Claude Code: orders with tracking numbers) | |
| Revoke B's key; the next call is rejected | `services/keys.ts` | dod-check: "admin revokes member key -> next /mcp call 401"; gateway-check | |
| Disable a server; its tools disappear from chat and the external client | `services/upstreams.ts`, registry NOTIFY | dod-check: "admin disables ship -> member list drops ship__ tools", "a direct call to the disabled server is rejected"; chat-check: "disabled server hidden from the agent (C4)" | |
| Kill an upstream's pod: others keep working; the dashboard shows it unreachable | health checks in `gateway/upstream-manager.ts` | dod-check: "delete the ship-mcp pod -> others unaffected, ship self-heals", "stop ship (0 pods) -> ship shows Unreachable", "while ship is down: woo call works, ship call fails fast" | |
| Every call is in the audit log, attributed to the right user | `services/audit.ts` (write-ahead) | dod-check: "audit rows for member B, attributed to B", "audit rows for admin A, attributed to A", "every audit row of this run is complete (write-ahead audit)" | |

## Kubernetes and Helm

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Runs on local Kubernetes | `scripts/cluster-up.sh` (k3d) | `make up` then `make verify` | |
| Deployable to a VPS with the same charts | `infra/scripts/deploy-ec2.sh` (k3s on EC2) | `verify-dod` on the VPS (README results) | |
| Helm, local and prod differences in values files | `infra/helm/*/values-local.yaml`, `values-prod.yaml` | `node scripts/values-diff.mjs`: only hosts, URLs, TLS, replicas, the store limit and one interval differ | |
| Values are typed | `infra/helm/*/values.schema.json` | chart-invariants: "values schema refuses …" (and its self-test) | |
| Everything runs in the cluster | both charts | verify-dod "kubernetes" section | |
| Persistent storage for the database and WordPress content | `mysql-statefulset.yaml`, `wordpress-pvc.yaml`, `postgres-statefulset.yaml` | verify-dod: "PVCs bound" | |
| Storefront and dashboard through Ingress with stable URLs | `urumi-store/templates/ingress.yaml`, `urumi-platform/templates/platform.yaml` | verify-dod: "Ingress exposes only the store and the platform" | |
| Local domain approach documented | README "Local domains" (`*.localhost`; nip.io on the VPS) | | |
| Readiness and liveness on every workload, requests and limits | every template | verify-dod: "probes, requests and limits on every workload"; chart-invariants | |
| No hardcoded secrets; credentials in Secrets | `scripts/secrets.sh`, `existingSecret` in values | `scripts/check-secrets.sh --tree` and `--history`; chart-invariants: no Helm-rendered Secrets | |

## WooCommerce MCP server

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Written by us, not an existing plugin | `services/woo-mcp/src/` | | |
| MCP over Streamable HTTP | `services/woo-mcp/src/server.ts` | in-cluster smoke (`tests/in-cluster-mcp.sh`) | |
| Tools: list products, create product, list orders, get order, update order status | `services/woo-mcp/src/tools.ts` (plus `get_store_info`) | woo-mcp unit tests; dod-check | |
| Not reachable from outside the cluster; only the gateway can call it | `urumi-platform/templates/networkpolicy.yaml`, ClusterIP, bearer token | verify-dod network isolation: "pod without gateway labels -> …" BLOCKED; in-cluster smoke "denied" pod | |
| How it talks to the store, and why | `services/woo-mcp/README.md` (REST API with OAuth 1.0a signatures, a shop-manager key) | verify-dod: "WooCommerce key owned by a shop_manager, not an admin" | |

## Gateway

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Add, edit, disable, remove servers with an optional static credential (header or bearer) | `services/upstreams.ts`, dashboard Servers page | api-check | |
| One MCP endpoint; listing aggregates enabled servers; calls are routed | `gateway/mcp.ts`, `gateway/upstream-manager.ts` | gateway-check, dod-check | |
| Tool name collisions: a documented scheme | `<prefix>__<tool>` (docs/SYSTEM_DESIGN.md §2) | dod-check: "colliding get_order is exposed once per server (G3)" | |
| A slow or dead upstream breaks nothing else; timeouts with a clear error | per-call timeouts, bulkhead (`lib/bulkhead.ts`) | isolation-check slow (25 s upstream vs 20 s timeout); dod-check: "while ship is down: list is fast …" | |
| Upstream credentials never reach the browser or a client | `lib/crypto.ts` (AES-256-GCM), `publicUpstream` | credential-isolation-check; api-check | |
| At least three upstreams | woo, ship, DeepWiki (and hosted servers, bonus stores) | dod-check: "every enabled server is connected" | |

## Team and access

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Admin and member roles | `services/users.ts`, `services/permissions.ts` | dod-check: "member list omits admin-only tools; admin sees them", "member calling woo__create_product directly -> denied" | |
| Own API keys, revocable, stored hashed | `services/keys.ts` (SHA-256) | gateway-check, api-check | |
| Audit log with user, server, tool, time, duration and outcome, in the dashboard | `services/audit.ts`, Audit page | dod-check audit checks; verify-dod: "audit is append-only for the app role" | |

## Chat agent

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| LLM calls tools through the gateway and shows which | `chat/agent.ts`, `chat/providers.ts`, Chat page tool cards | chat-check | |
| Acts as the logged-in user; calls in the audit log under that user | `api/routes.ts` (`/api/chat`) | chat-check; dod-check audit (source chat) | |
| LLM keys are Secrets | `platform-llm` Secret from `scripts/secrets.sh` | check-secrets | |

## Bonus: multi-store

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Create and delete stores from the dashboard; status, URL, created time; several at once | Stores page, `services/stores.ts` | stores-check: "two stores created at the same time both become Ready" | |
| Helm or the Kubernetes API, own namespace, database, Secrets, volumes, Ingress host | `provision/stores.ts` (the `urumi-store` chart by Helm) | stores-check: "each storefront is its own store" | |
| Each store gets its own MCP server, registered automatically; names show the store | the chart's `mcp.yaml`, `<name>__*` | stores-check: "each store's MCP server answers as that store" | |
| Clean teardown | `storeTeardown` in `provision/stores.ts` | stores-check: "delete: tools gone at once, then the namespace and its volumes" | |
| Isolation with NetworkPolicies | the store chart's policies | stores-check: "stores cannot reach each other" | |
| ResourceQuota and LimitRange per store; a maximum per user; a provisioning timeout | `provision/stores.ts`, `services/stores.ts` | stores-check: "guardrails: a ResourceQuota and a LimitRange in each store namespace", "the limit holds"; provision-rows-check: "P14: a user's own stores are limited (maxPerUser)" | |
| Safe to retry; a provisioner restart mid-install completes or fails cleanly | `provision/rows.ts` (leases, compare-and-set), `provision/steps.ts` | stores-check (provisioner restarted mid-way); provision-rows-check | |
| The test: chat compares today's orders across two stores; delete one, its tools and resources are gone | | stores-check: "chat compares today's orders across two stores (P15)", "after the delete, chat no longer offers the store's tools (P15)" | |

## Stand-out items

| Item | Where | Proven by | Video |
|---|---|---|---|
| 1. VPS deployment, TLS | `infra/scripts/deploy-ec2.sh`, `values-prod.yaml` | `verify-dod` on the VPS | |
| 2. Tool permissions | `services/permissions.ts` | dod-check, features-check | |
| 3. OAuth | `api/oauth.ts`, `services/oauth.ts` | oauth-check | |
| 4. Many tools | `gateway/mcp.ts` (`gateway__search_tools`, `gateway__call_tool`) | features-check; stores-check (tool search) | |
| 5. Hosted MCP servers | `provision/hosted.ts`, Hosted servers page | hosted-check (7 checks), `tests/rbac-check.sh` (49) | |
| 6. Security hardening | `lib/ssrf.ts`, NetworkPolicies, Pod Security restricted, `lib/crypto.ts` | api-check: "SSRF: metadata, loopback-by-DNS and internal hosts refused (400)"; verify-dod network isolation and "namespace enforces Pod Security restricted", evil-check, credential-isolation-check | |
| 7. Scaling | `platform-scaling.yaml`, `lib/ratelimit.ts` | scaling-check, auth-shield-check | |
| 8. Observability | `lib/metrics.ts`, Servers page statistics | dod-check: "overview: calls, error rate and latency per server", "one request id: client response, audit row, woo-mcp log" | |
| 9. Upgrades and rollback | `scripts/upgrade-rollback-demo.sh` | the script's own result (zero failed requests) | |

## Deliverables

| Requirement | Where |
|---|---|
| README: local setup, VPS setup, placing an order, an external client, the chat | `README.md` |
| Source for the dashboard, backend and gateway, woo-mcp and the chat agent | `services/` |
| Helm charts and values files | `infra/helm/` |
| System design and tradeoffs | `docs/SYSTEM_DESIGN.md` |
| Threat model | `docs/THREAT_MODEL.md` |
| Bonus and stand-out items, and where to find them | README "Stand-out items and where to find them", this file |
