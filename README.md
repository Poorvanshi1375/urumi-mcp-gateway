# Urumi MCP Gateway

A WooCommerce store on Kubernetes with a team MCP gateway in front of it. An admin registers MCP servers once in a dashboard; every team member then reaches all of their tools through one MCP endpoint (Claude Code, Cursor, MCP Inspector) and through a chat agent in the dashboard. The same two Helm charts run on a laptop (k3d) and on a VPS (k3s), with only values changed.

```
                      browser, Claude Code, Cursor, MCP Inspector
                                        |
                          Traefik Ingress (TLS on the VPS)
                 +----------------------+-----------------------+
                 |                                              |
         store.<domain>                            app.<domain>  (/, /api, /mcp)
                 |                                              |
        +--------v--------+                      +--------------v---------------+
        | WordPress +     |                      | platform (2+ replicas)        |
        | WooCommerce     |<---- REST (OAuth) ---|  dashboard (React), /api,     |
        +--------+--------+          ^           |  MCP gateway /mcp, chat agent |
                 |                   |           +---+----------+-----------+----+
        +--------v--------+   +------+------+        |          |           |
        | MySQL (PVC)     |   |  woo-mcp    |<-------+     +----v-----+  +--v-----------+
        +-----------------+   +-------------+  MCP        | ship-mcp |  | DeepWiki     |
                                (ClusterIP only)          +----------+  | (public MCP) |
                               platform ---> Postgres (PVC): users, keys, servers, audit
                               platform ---> Gemini API (chat)
```

Everything except DeepWiki and Gemini runs in the cluster, in namespace `urumi`. The MCP servers have no Ingress; NetworkPolicies let only the gateway reach them.

| Component | Code | What it does |
|---|---|---|
| Store | `infra/helm/urumi-store` | WordPress 7.1 + WooCommerce 11.2 + MySQL 8.4, persistent volumes, a WP-CLI Job that installs and configures the shop |
| woo-mcp | `services/woo-mcp` | Our MCP server for the store: list/create products, list/get orders, update order status, over the WooCommerce REST API ([how and why](services/woo-mcp/README.md)) |
| ship-mcp | `services/ship-mcp` | A second MCP server we wrote (shipping quotes and tracking); its `get_order` deliberately collides with woo-mcp's |
| DeepWiki | external | A public MCP server (`https://mcp.deepwiki.com/mcp`), the third upstream |
| platform | `services/platform`, `services/dashboard` | One Node service: the MCP gateway (`/mcp`), the dashboard API (`/api`), the chat agent, and the React dashboard |
| Postgres | `infra/helm/urumi-platform` | Users, sessions, API key hashes, registered servers (credentials encrypted), permissions, audit and activity logs |

## Contents

- [Run it locally](#run-it-locally)
- [Use it](#use-it): place an order, connect an MCP client, use the chat agent, manage the team
- [Deploy to a VPS](#deploy-to-a-vps-k3s)
- [Upgrade and roll back](#upgrade-and-roll-back)
- [Check that it works](#check-that-it-works)
- [Stand-out items](#stand-out-items-and-where-to-find-them)
- [Repository layout](#repository-layout) and [further documents](#further-documents)

## Run it locally

### Prerequisites

| Tool | Version used | Notes |
|---|---|---|
| Docker | Docker Desktop 29 (WSL 2 integration on Windows) | give it at least 6 GB of memory; the whole system uses about 2.5 GB |
| k3d | 5.9 | creates a k3s 1.35 cluster in Docker |
| kubectl | 1.37 | |
| Helm | 3.22 | |
| Node.js | 24 | only for the check scripts and the demo-data script |
| make, openssl, curl | any | |
| Gemini API key | optional | for the chat agent; free key from Google AI Studio. Everything else works without it |

### Install

```bash
git clone <this repo> urumi-mcp-gateway && cd urumi-mcp-gateway
make cluster                                   # k3d cluster "urumi-local": Traefik on :9080, NetworkPolicy enforced
make secrets GEMINI_KEY_FILE=~/gemini.key      # creates the Kubernetes Secrets (omit the key file to skip chat)
make install                                   # builds the 3 images, installs the store chart, then the platform chart
make hooks                                     # optional: pre-commit check that refuses committed secrets
```

`make install` takes about 5 minutes the first time (the store's setup Job downloads WooCommerce). `make up` runs all three steps.

What each step does:
- `scripts/cluster-up.sh` creates (or starts) the k3d cluster: k3s v1.35.5, one server and one agent node, Traefik published on host port 9080. k3s enforces NetworkPolicies itself (kube-router), so the charts' policies are real locally too. It also loads the third-party images from the host into the nodes, because pulls from inside k3d nodes are unreliable on Docker Desktop.
- `scripts/secrets.sh` creates `store-secrets`, `platform-secrets` and `platform-llm` with random values. It never overwrites an existing value, because the databases on the volumes were created with them. The charts only reference these Secrets by name (`secrets.existingSecret`), so no secret is ever in git, in values files or in Helm's release history.
- `make install` builds the images (tag = the last git commit of their sources), loads them into the nodes, and runs `helm upgrade --install` for both charts with `values-local.yaml`.

### Local domains

| URL | What |
|---|---|
| http://store.localhost:9080/shop/ | storefront |
| http://store.localhost:9080/wp-admin | WordPress admin (user `admin`) |
| http://localhost:9080 | dashboard |
| http://localhost:9080/mcp | MCP gateway endpoint |

Browsers and curl resolve every `*.localhost` name to 127.0.0.1 by themselves (RFC 6761), so no hosts-file edits are needed. The k3d load balancer forwards host port 9080 to Traefik, which routes by host name. The gateway uses plain `localhost` rather than `app.localhost` because Node-based clients on WSL (Claude Code, our scripts) do not resolve `*.localhost` names.

### First login and demo users

```bash
kubectl get secret -n urumi platform-secrets -o jsonpath='{.data.admin-password}' | base64 -d; echo   # admin@example.com
kubectl get secret -n urumi store-secrets -o jsonpath='{.data.wp-admin-password}' | base64 -d; echo   # WordPress "admin"
tests/reset-demo.sh          # creates User A (admin) and User B (member) through the invite flow
cat ~/urumi-demo-credentials.txt
```

`tests/reset-demo.sh` also clears the audit and activity logs and all API keys (it asks first; `--yes` skips the question). Registered servers and the store are kept.

## Use it

### Place an order

1. Open http://store.localhost:9080/shop/, add a product to the cart, go to checkout.
2. Fill in any address in India and choose **Cash on delivery**, then **Place order**.
3. The order appears in WordPress admin under **WooCommerce → Orders**, status Processing.

### Connect an MCP client (only the gateway URL and your key)

In the dashboard, open **API keys → Create key**. The key (`urk_...`) is shown once; the gateway stores only its SHA-256 hash. The **Connect** page shows the snippets below with the right URL.

**Claude Code** (tested with 2.1.300):
```bash
claude mcp add --transport http urumi http://localhost:9080/mcp --header "Authorization: Bearer urk_..."
claude          # then /mcp shows "urumi" connected and its tools
```
Tools appear as `mcp__urumi__woo__list_orders` and so on. Claude Code follows tool-list changes live: disable a server in the dashboard and its tools disappear from the session within a second or two.

**MCP Inspector** (CLI tested with 2.8.0):
```bash
npx @modelcontextprotocol/inspector@2.8.0 --cli http://localhost:9080/mcp --transport http \
  --header "Authorization: Bearer urk_..." --method tools/list
npx @modelcontextprotocol/inspector@2.8.0 --cli http://localhost:9080/mcp --transport http \
  --header "Authorization: Bearer urk_..." --method tools/call --tool-name woo__list_orders --tool-arg per_page=3
```
In the Inspector's web UI (`npx @modelcontextprotocol/inspector@2.8.0`), use transport Streamable HTTP, the same URL, and a header `Authorization` with `Bearer urk_...`. (We tested the CLI, not the web UI.)

**Cursor** (not tested by us): add to `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json`:
```json
{ "mcpServers": { "urumi": { "url": "http://localhost:9080/mcp", "headers": { "Authorization": "Bearer urk_..." } } } }
```

Clients that use the 2025 protocol revision (Inspector, Cursor) see tool-list changes on their next list; calls to a disabled or restricted tool are refused at once either way.

Tool names are `<server prefix>__<tool>`, for example `woo__get_order` and `ship__get_order`; the gateway routes on the first `__`. Members do not see admin-only tools (by default `woo__create_product` and `woo__update_order_status`).

### Use the chat agent

Open **Chat** in the dashboard and ask, for example, "What orders came in today?" or "Create a product called Urumi Tote Bag priced at 799". Each tool call appears as a card with its arguments, result and duration. The agent (Gemini, `gemini-3.5-flash` with `gemini-3.5-flash-lite` as fallback) acts as the signed-in user: it only gets that user's tools, and every call is in the audit log under that user with source `chat`. It needs the `platform-llm` Secret (`make secrets GEMINI_KEY_FILE=...`).

### Manage the team (admins)

- **Servers**: add a server by URL with an optional bearer token or custom header (stored encrypted, never shown again), edit, disable or remove it, see its status (Connected, Degraded, Unreachable, Disabled) and tools, and choose per tool whether members may use it.
- **People**: invite members (one-time link), change roles, disable users.
- **API keys**: tick "Show everyone's keys" to see and revoke any key.
- **Audit log**: every tool call (user, server, tool, time, duration, outcome) and, under **Activity**, every admin and account action. Members see only their own rows.

## Deploy to a VPS (k3s)

Tested on AWS EC2: Ubuntu 24.04, `m7i-flex.large` (2 vCPU, 8 GiB), 30 GB disk, an Elastic IP, security group with SSH (22) from your IP and HTTP/HTTPS (80, 443) from anywhere.

```bash
LETSENCRYPT_EMAIL=you@example.com infra/scripts/deploy-ec2.sh <public-ip> ~/.ssh/<key>.pem
```

The script runs from the laptop, over SSH, and is safe to re-run:
1. installs k3s v1.35.5 (same as local) and copies Helm to the node;
2. copies our three images (the tags running locally) into k3s's containerd;
3. ships the charts as committed in git (`git archive HEAD`), never the working tree;
4. runs `scripts/secrets.sh` on the node (the Gemini key travels through a mode-600 temp file that is deleted right after);
5. installs cert-manager v1.21.2 and a Let's Encrypt ClusterIssuer (HTTP-01 through Traefik);
6. installs the store and platform charts with `values-prod.yaml` and the host names below.

URLs: `https://store.<ip>.nip.io/shop/`, `https://app.<ip>.nip.io/` and `https://app.<ip>.nip.io/mcp`. nip.io resolves a name to the IP inside it, so no DNS setup is needed; with a real domain, set the hosts instead.

### What changes between local and the VPS (values only)

| Concern | Local k3d (`values-local.yaml`) | VPS k3s (`values-prod.yaml` + `deploy-ec2.sh`) |
|---|---|---|
| Host names | `store.localhost:9080`, `localhost:9080` | `store.<ip>.nip.io`, `app.<ip>.nip.io` |
| Store home URL | `http://store.localhost:9080` | `https://store.<ip>.nip.io` |
| URL woo-mcp signs WooCommerce requests over | same as the home URL | `http://store.<ip>.nip.io` (the in-cluster call is plain HTTP) |
| TLS | none | Let's Encrypt via cert-manager; http redirected to https |
| Gateway replicas | 2 | HorizontalPodAutoscaler, 2 to 4 on CPU |
| Health check interval | 5 s | 10 s |
| Extra Service port on WordPress | 9080 (in-cluster calls must use the signed URL's port) | none |
| Storage class | `local-path` | `local-path` (use the cloud provider's class elsewhere) |
| Secrets | `make secrets` | `secrets.sh` run on the node |
| Images | built and loaded into k3d | the same tags copied over SSH (a registry would replace this) |

To reach the VPS cluster's API from the laptop without opening port 6443, use an SSH tunnel: `ssh -i <key> -f -N -L 16443:127.0.0.1:6443 ubuntu@<ip>` and a kubeconfig that points at `https://127.0.0.1:16443`.

## Upgrade and roll back

```bash
scripts/upgrade-rollback-demo.sh                       # local
KUBECONFIG=<vps kubeconfig> GW_URL=https://app.<ip>.nip.io scripts/upgrade-rollback-demo.sh
```

It upgrades the gateway to an image tag that does not exist, shows the new pods stuck in `ImagePullBackOff` while the old ones keep serving, runs `helm rollback` to the last good revision, and counts failed requests from a client calling the gateway every 200 ms. Measured: 146 requests on the VPS and 423 locally, 0 failed. Why it is safe: rolling updates only remove an old pod once a new one is Ready, a PodDisruptionBudget keeps one replica, and a `preStop` pause lets Traefik stop routing before a pod exits.

Normal upgrades: `make install` locally, or re-run `deploy-ec2.sh`. Volumes and Secrets survive upgrades and `helm uninstall`; database migrations run in an init container before the new version starts. Do not use `helm upgrade --reuse-values` (it skips new chart defaults); use `--reset-then-reuse-values` or pass the values files.

## Check that it works

```bash
(cd services/platform && npm ci) && (cd services/woo-mcp && npm ci)    # once, for the check scripts
make verify          # secret scans + scripts/verify-dod.sh
scripts/verify-dod.sh --all     # also: Gemini chat, real Claude Code and MCP Inspector sessions, slow upstream
```

`scripts/verify-dod.sh` runs against the live cluster and checks the definition of done end to end: storefront and WooCommerce REST; PVCs, probes, limits and security contexts on every container; NetworkPolicies (pods without the gateway's labels cannot reach the MCP servers, databases, WordPress or `/metrics`; the MCP servers cannot reach anything but what they need); keys rejected when missing, invalid or revoked; every enabled server's tools listed with namespaced names; restricted tools hidden and denied; an orders question and a two-server task; disabling a server; killing an upstream pod and stopping it entirely; two-replica behaviour and rate limits; the audit and activity logs. It uses temporary users and removes them and their data afterwards, so it can run on a demo system. Latest results: local `--all` 34 passed, VPS (over HTTPS) 27 passed, 0 failed.

## Stand-out items and where to find them

| Item from the assignment | What we built | Where |
|---|---|---|
| 1. Production-like VPS deployment | k3s on EC2 with the same charts, TLS from Let's Encrypt, values-only differences | `infra/scripts/deploy-ec2.sh`, `values-prod.yaml`, [VPS section](#deploy-to-a-vps-k3s) |
| 2. Tool permissions | Per-role rules per server and tool; restricted tools hidden from listing and refused (audited `denied`) for MCP clients and the chat agent alike; editable per tool in the dashboard | `services/platform/src/services/permissions.ts`, `src/gateway/mcp.ts` |
| 4. Handling many tools | Tool search mode: `/mcp?mode=search` exposes `gateway__search_tools` and `gateway__call_tool` (behind `platform.features.toolSearch`) | `src/gateway/mcp.ts` |
| 6. Security hardening | SSRF guard (checked at registration and on every connection), default-deny NetworkPolicies with egress lockdown for MCP servers, every container non-root with a read-only root filesystem, upstream credentials encrypted with AES-256-GCM, tool pinning against changed tool descriptions (behind `platform.features.toolPinning`), committed-secret check | `src/lib/ssrf.ts`, `templates/networkpolicy.yaml`, `src/services/pins.ts`, `scripts/check-secrets.sh` |
| 7. Scaling | Stateless MCP; 2 replicas locally, HPA 2 to 4 on the VPS, PodDisruptionBudget; per-key and per-user rate limits; shared sign-in throttling; replicas synchronised through Postgres NOTIFY | `templates/platform-scaling.yaml`, `src/lib/ratelimit.ts` |
| 8. Observability | Prometheus `/metrics` on a private port (calls, errors and latency per server, upstream up, rejected requests); unreachable reasons shown in the dashboard; activity log | `src/lib/metrics.ts` |
| 9. Upgrades and rollback | Scripted broken-image upgrade and `helm rollback` with zero failed requests | `scripts/upgrade-rollback-demo.sh` |

Not attempted: OAuth on the gateway (3), hosted MCP servers by container image (5), and the multi-store bonus.

## Repository layout

```
services/platform        gateway, dashboard API, chat agent (Fastify, MCP TypeScript SDK v2, Drizzle + Postgres)
services/dashboard       React 19 + Vite dashboard, served by the platform
services/woo-mcp         our WooCommerce MCP server
services/ship-mcp        our second MCP server (shipping)
infra/helm/urumi-store   store chart          infra/helm/urumi-platform   platform chart (gateway, Postgres, MCP servers)
infra/scripts            image build and k3d import, deploy-ec2.sh
scripts                  cluster-up, secrets, verify-dod, check-secrets, upgrade-rollback-demo
tests                    demo reset, test order, in-cluster MCP smoke tests, real-client checks
```

## Further documents

- [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md): architecture, aggregation and routing, failure handling, production changes
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): credentials, token pass-through, untrusted upstreams, what members can do
- [services/woo-mcp/README.md](services/woo-mcp/README.md): how woo-mcp talks to the store, and why
