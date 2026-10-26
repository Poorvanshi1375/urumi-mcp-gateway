# Requirements and where they are proven

Every line of the assignment, the code that implements it, the check that proves it, and where the demo video shows it. Checks run with `make verify` (`scripts/verify-dod.sh`; suites in `services/platform/test/`), `make verify-all` (also the chat, hosted-server, malicious-server and store suites), or offline (`node scripts/chart-invariants.mjs`, `node scripts/values-diff.mjs`, CI). "dod-check: …" names a check printed by `services/platform/test/dod-check.mjs`, and so on.

Video: [https://youtu.be/mW9fIbwzoZE](https://youtu.be/mW9fIbwzoZE) (33 min, with chapters). Each time below opens the video at that moment; a blank cell means the item is in the code and docs but not shown on screen.

## Definition of done (two users)

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Storefront: add to cart, check out with cash on delivery | `infra/helm/urumi-store/files/setup.sh` (the setup Job enables cash on delivery) | verify-dod: "storefront /shop/ responds", "WooCommerce REST (Store API) responds"; an order is placed through the Store API when the store has none | [2:40](https://youtu.be/mW9fIbwzoZE?t=160) |
| The order is visible in WooCommerce admin | the store's wp-admin | verify-dod: "wp-admin login page"; `woo__get_order` returns it (dod-check) | [3:06](https://youtu.be/mW9fIbwzoZE?t=186) |
| User A: chat creates a product with a name and price; it appears on the storefront | `services/platform/src/chat/agent.ts`, `services/woo-mcp/src/tools.ts` (`create_product`) | chat-check: "C: confirm runs it once, audited (D2 mechanism)" | [3:59](https://youtu.be/mW9fIbwzoZE?t=239) |
| User A: order it by hand, ask what came in today | `woo__list_orders` with `created_on: "today"` in the store's timezone | chat-check: "orders on a day -> woo__list_orders (C1, D3)" | [5:12](https://youtu.be/mW9fIbwzoZE?t=312) |
| User B: an external client with only the gateway URL and B's key | `services/platform/src/gateway/mcp.ts`, `gateway/auth.ts` | clients-check (MCP Inspector and Claude Code over the replicas) | [6:42](https://youtu.be/mW9fIbwzoZE?t=402) |
| User B sees every enabled server's tools and asks the same question | `gateway/upstream-manager.ts` | dod-check: "member tools/list has namespaced tools of each server", "member: \"orders today\" via woo__list_orders" | [6:57](https://youtu.be/mW9fIbwzoZE?t=417) |
| One prompt needs tools from two servers | woo and ship | dod-check: "member: latest order from woo, then its shipment from ship"; clients-check (Claude Code: orders with tracking numbers) | [7:45](https://youtu.be/mW9fIbwzoZE?t=465) |
| Revoke B's key; the next call is rejected | `services/keys.ts` | dod-check: "admin revokes member key -> next /mcp call 401"; gateway-check | [9:39](https://youtu.be/mW9fIbwzoZE?t=579) |
| Disable a server; its tools disappear from chat and the external client | `services/upstreams.ts`, registry NOTIFY | dod-check: "admin disables ship -> member list drops ship__ tools", "a direct call to the disabled server is rejected"; chat-check: "disabled server hidden from the agent (C4)" | [8:09](https://youtu.be/mW9fIbwzoZE?t=489) |
| Kill an upstream's pod: others keep working; the dashboard shows it unreachable | health checks in `gateway/upstream-manager.ts` | dod-check: "delete the ship-mcp pod -> others unaffected, ship self-heals", "stop ship (0 pods) -> ship shows Unreachable", "while ship is down: woo call works, ship call fails fast" | [8:41](https://youtu.be/mW9fIbwzoZE?t=521) |
| Every call is in the audit log, attributed to the right user | `services/audit.ts` (write-ahead) | dod-check: "audit rows for member B, attributed to B", "audit rows for admin A, attributed to A", "every audit row of this run is complete (write-ahead audit)" | [10:08](https://youtu.be/mW9fIbwzoZE?t=608) |

## Kubernetes and Helm

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Runs on local Kubernetes | `scripts/cluster-up.sh` (k3d) | `make up` then `make verify` | [10:56](https://youtu.be/mW9fIbwzoZE?t=656) |
| Deployable to a VPS with the same charts | `infra/scripts/deploy-ec2.sh` (k3s on EC2) | `verify-dod` on the VPS (README results) | [24:46](https://youtu.be/mW9fIbwzoZE?t=1486) |
| Helm, local and prod differences in values files | `infra/helm/*/values-local.yaml`, `values-prod.yaml` | `node scripts/values-diff.mjs`: only hosts, URLs, TLS, replicas, the store limit and one interval differ | [25:21](https://youtu.be/mW9fIbwzoZE?t=1521) |
| Values are typed | `infra/helm/*/values.schema.json` | chart-invariants: "values schema refuses …" (and its self-test) | [25:53](https://youtu.be/mW9fIbwzoZE?t=1553) |
| Everything runs in the cluster | both charts | verify-dod "kubernetes" section | [10:56](https://youtu.be/mW9fIbwzoZE?t=656) |
| Persistent storage for the database and WordPress content | `mysql-statefulset.yaml`, `wordpress-pvc.yaml`, `postgres-statefulset.yaml` | verify-dod: "PVCs bound" | [11:17](https://youtu.be/mW9fIbwzoZE?t=677) |
| Storefront and dashboard through Ingress with stable URLs | `urumi-store/templates/ingress.yaml`, `urumi-platform/templates/platform.yaml` | verify-dod: "Ingress exposes only the store and the platform" | [11:34](https://youtu.be/mW9fIbwzoZE?t=694) |
| Local domain approach documented | README "Local domains" (`*.localhost`; nip.io on the VPS) | | |
| Readiness and liveness on every workload, requests and limits | every template | verify-dod: "probes, requests and limits on every workload"; chart-invariants | [13:29](https://youtu.be/mW9fIbwzoZE?t=809) |
| No hardcoded secrets; credentials in Secrets | `scripts/secrets.sh`, `existingSecret` in values | `scripts/check-secrets.sh --tree` and `--history`; chart-invariants: no Helm-rendered Secrets | [11:45](https://youtu.be/mW9fIbwzoZE?t=705) |

## WooCommerce MCP server

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Written by us, not an existing plugin | `services/woo-mcp/src/` | | [3:44](https://youtu.be/mW9fIbwzoZE?t=224) |
| MCP over Streamable HTTP | `services/woo-mcp/src/server.ts` | in-cluster smoke (`tests/in-cluster-mcp.sh`) | |
| Tools: list products, create product, list orders, get order, update order status | `services/woo-mcp/src/tools.ts` (plus `get_store_info`) | woo-mcp unit tests; dod-check | [3:44](https://youtu.be/mW9fIbwzoZE?t=224) |
| Not reachable from outside the cluster; only the gateway can call it | `urumi-platform/templates/networkpolicy.yaml`, ClusterIP, bearer token | verify-dod network isolation: "pod without gateway labels -> …" BLOCKED; in-cluster smoke "denied" pod | [12:10](https://youtu.be/mW9fIbwzoZE?t=730) |
| How it talks to the store, and why | `services/woo-mcp/README.md` (REST API with OAuth 1.0a signatures, a shop-manager key) | verify-dod: "WooCommerce key owned by a shop_manager, not an admin" | [15:40](https://youtu.be/mW9fIbwzoZE?t=940) |

## Gateway

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Add, edit, disable, remove servers with an optional static credential (header or bearer) | `services/upstreams.ts`, dashboard Servers page | api-check | [8:09](https://youtu.be/mW9fIbwzoZE?t=489), [19:26](https://youtu.be/mW9fIbwzoZE?t=1166) |
| One MCP endpoint; listing aggregates enabled servers; calls are routed | `gateway/mcp.ts`, `gateway/upstream-manager.ts` | gateway-check, dod-check | [14:29](https://youtu.be/mW9fIbwzoZE?t=869) |
| Tool name collisions: a documented scheme | `<prefix>__<tool>` (docs/SYSTEM_DESIGN.md §2) | dod-check: "colliding get_order is exposed once per server (G3)" | [16:06](https://youtu.be/mW9fIbwzoZE?t=966) |
| A slow or dead upstream breaks nothing else; timeouts with a clear error | per-call timeouts, bulkhead (`lib/bulkhead.ts`) | isolation-check slow (25 s upstream vs 20 s timeout); dod-check: "while ship is down: list is fast …" | [8:41](https://youtu.be/mW9fIbwzoZE?t=521), [16:37](https://youtu.be/mW9fIbwzoZE?t=997) |
| Upstream credentials never reach the browser or a client | `lib/crypto.ts` (AES-256-GCM), `publicUpstream` | credential-isolation-check; api-check | [17:58](https://youtu.be/mW9fIbwzoZE?t=1078) |
| At least three upstreams | woo, ship, DeepWiki (and hosted servers, bonus stores) | dod-check: "every enabled server is connected" | [3:26](https://youtu.be/mW9fIbwzoZE?t=206) |

## Team and access

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Admin and member roles | `services/users.ts`, `services/permissions.ts` | dod-check: "member list omits admin-only tools; admin sees them", "member calling woo__create_product directly -> denied" | [6:04](https://youtu.be/mW9fIbwzoZE?t=364), [18:32](https://youtu.be/mW9fIbwzoZE?t=1112) |
| Own API keys, revocable, stored hashed | `services/keys.ts` (SHA-256) | gateway-check, api-check | [6:19](https://youtu.be/mW9fIbwzoZE?t=379), [9:39](https://youtu.be/mW9fIbwzoZE?t=579) |
| Audit log with user, server, tool, time, duration and outcome, in the dashboard | `services/audit.ts`, Audit page | dod-check audit checks; verify-dod: "audit is append-only for the app role" | [10:08](https://youtu.be/mW9fIbwzoZE?t=608) |

## Chat agent

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| LLM calls tools through the gateway and shows which | `chat/agent.ts`, `chat/providers.ts`, Chat page tool cards | chat-check | [5:31](https://youtu.be/mW9fIbwzoZE?t=331), [23:22](https://youtu.be/mW9fIbwzoZE?t=1402) |
| Acts as the logged-in user; calls in the audit log under that user | `api/routes.ts` (`/api/chat`) | chat-check; dod-check audit (source chat) | [10:32](https://youtu.be/mW9fIbwzoZE?t=632), [23:56](https://youtu.be/mW9fIbwzoZE?t=1436) |
| LLM keys are Secrets | `platform-llm` Secret from `scripts/secrets.sh` | check-secrets | |

## Bonus: multi-store

| Requirement | Where | Proven by | Video |
|---|---|---|---|
| Create and delete stores from the dashboard; status, URL, created time; several at once | Stores page, `services/stores.ts` | stores-check: "two stores created at the same time both become Ready" | [29:19](https://youtu.be/mW9fIbwzoZE?t=1759) |
| Helm or the Kubernetes API, own namespace, database, Secrets, volumes, Ingress host | `provision/stores.ts` (the `urumi-store` chart by Helm) | stores-check: "each storefront is its own store" | [29:38](https://youtu.be/mW9fIbwzoZE?t=1778) |
| Each store gets its own MCP server, registered automatically; names show the store | the chart's `mcp.yaml`, `<name>__*` | stores-check: "each store's MCP server answers as that store" | [29:49](https://youtu.be/mW9fIbwzoZE?t=1789) |
| Clean teardown | `storeTeardown` in `provision/stores.ts` | stores-check: "delete: tools gone at once, then the namespace and its volumes" | [31:34](https://youtu.be/mW9fIbwzoZE?t=1894), [31:50](https://youtu.be/mW9fIbwzoZE?t=1910) |
| Isolation with NetworkPolicies | the store chart's policies | stores-check: "stores cannot reach each other" | [30:16](https://youtu.be/mW9fIbwzoZE?t=1816) |
| ResourceQuota and LimitRange per store; a maximum per user; a provisioning timeout | `provision/stores.ts`, `services/stores.ts` | stores-check: "guardrails: a ResourceQuota and a LimitRange in each store namespace", "the limit holds"; provision-rows-check: "P14: a user's own stores are limited (maxPerUser)" | [29:56](https://youtu.be/mW9fIbwzoZE?t=1796), [30:16](https://youtu.be/mW9fIbwzoZE?t=1816) |
| Safe to retry; a provisioner restart mid-install completes or fails cleanly | `provision/rows.ts` (leases, compare-and-set), `provision/steps.ts` | stores-check (provisioner restarted mid-way); provision-rows-check | [32:04](https://youtu.be/mW9fIbwzoZE?t=1924) |
| The test: chat compares today's orders across two stores; delete one, its tools and resources are gone | | stores-check: "chat compares today's orders across two stores (P15)", "after the delete, chat no longer offers the store's tools (P15)" | [31:00](https://youtu.be/mW9fIbwzoZE?t=1860), [31:34](https://youtu.be/mW9fIbwzoZE?t=1894) |

## Stand-out items

| Item | Where | Proven by | Video |
|---|---|---|---|
| 1. VPS deployment, TLS | `infra/scripts/deploy-ec2.sh`, `values-prod.yaml` | `verify-dod` on the VPS | [24:46](https://youtu.be/mW9fIbwzoZE?t=1486) |
| 2. Tool permissions | `services/permissions.ts` | dod-check, features-check | [18:55](https://youtu.be/mW9fIbwzoZE?t=1135) |
| 3. OAuth | `api/oauth.ts`, `services/oauth.ts` | oauth-check | |
| 4. Many tools | `gateway/mcp.ts` (`gateway__search_tools`, `gateway__call_tool`) | features-check; stores-check (tool search) | [24:30](https://youtu.be/mW9fIbwzoZE?t=1470) |
| 5. Hosted MCP servers | `provision/hosted.ts`, Hosted servers page | hosted-check (7 checks), `tests/rbac-check.sh` (49) | [27:10](https://youtu.be/mW9fIbwzoZE?t=1630) |
| 6. Security hardening | `lib/ssrf.ts`, NetworkPolicies, Pod Security restricted, `lib/crypto.ts` | api-check: "SSRF: metadata, loopback-by-DNS and internal hosts refused (400)"; verify-dod network isolation and "namespace enforces Pod Security restricted", evil-check, credential-isolation-check | [17:46](https://youtu.be/mW9fIbwzoZE?t=1066), [12:52](https://youtu.be/mW9fIbwzoZE?t=772) |
| 7. Scaling | `platform-scaling.yaml`, `lib/ratelimit.ts` | scaling-check, auth-shield-check | [25:38](https://youtu.be/mW9fIbwzoZE?t=1538) |
| 8. Observability | `lib/metrics.ts`, Servers page statistics | dod-check: "overview: calls, error rate and latency per server", "one request id: client response, audit row, woo-mcp log" | [17:14](https://youtu.be/mW9fIbwzoZE?t=1034) |
| 9. Upgrades and rollback | `scripts/upgrade-rollback-demo.sh` | the script's own result (zero failed requests) | [26:37](https://youtu.be/mW9fIbwzoZE?t=1597) |

## Deliverables

| Requirement | Where |
|---|---|
| README: local setup, VPS setup, placing an order, an external client, the chat | `README.md` |
| Source for the dashboard, backend and gateway, woo-mcp and the chat agent | `services/` |
| Helm charts and values files | `infra/helm/` |
| System design and tradeoffs | `docs/SYSTEM_DESIGN.md` |
| Threat model | `docs/THREAT_MODEL.md` |
| Bonus and stand-out items, and where to find them | README "Stand-out items and where to find them", this file |
