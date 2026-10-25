# Urumi MCP Gateway

A WooCommerce store on Kubernetes with a team MCP gateway in front of it. An admin registers MCP servers once in a dashboard; every team member then reaches all of their tools through one MCP endpoint (Claude Code, Cursor, MCP Inspector) and through a chat agent in the dashboard. The same two Helm charts run on a laptop (k3d) and on a VPS (k3s), with only values changed.

```
                      browser, Claude Code, Cursor, MCP Inspector
                                        |
                          Traefik Ingress (TLS on the VPS)
                 +----------------------+------------------------+
                 |                                               |
          store.<domain>                            app.<domain>  (/, /api, /mcp)
                 |                                               |
        +--------v--------+                     +----------------v---------------+
        | WordPress +     |                     | platform (2+ replicas,         |
        | WooCommerce     |<--- REST (OAuth) ---|   no Kubernetes token)         |
        +--------+--------+         ^           |  dashboard (React), /api,      |
                 |                  |           |  MCP gateway /mcp, chat agent  |
        +--------v--------+  +------+------+    +---+----------+------------+----+
        | MySQL (PVC)     |  |  woo-mcp    |<-------+          |            |
        +-----------------+  +-------------+   MCP       +-----v----+  +----v---------+
                               (ClusterIP only)          | ship-mcp |  | DeepWiki     |
                                                         +----------+  | (public MCP) |
                                                                       +--------------+
          platform ---> Postgres (PVC): users, key hashes, servers, audit, stores
          platform ---> Gemini API, with Groq as fallback (chat)

  Hosted MCP servers and bonus stores: the gateway only writes a row; the provisioner acts.

        dashboard /api ------ writes a row ------> Postgres
                                                       ^
                                                       | claims rows (leases)
                                          +------------+-----------------+
                                          | provisioner: the only pod    |
                                          | with a Kubernetes token      |
                                          +------------+-----------------+
                                                       | Kubernetes API, fenced by
                                                       | RBAC + 5 admission policies
                      +--------------------------------+-------------------------+
                      |                                                          |
  +-------------------v----------------+       +---------------------------------v--+
  | namespace store-<name>             |       | namespace mcp-<prefix>             |
  | (one per bonus store)              |       | (one per hosted server)            |
  | WordPress, MySQL, its own woo-mcp; |       | the admin's image, or a stdio      |
  | quota, LimitRange, default-deny    |       | server via our bridge; quota,      |
  |                                    |       | default-deny                       |
  +-------------------^----------------+       +---------------------------------^--+
                      +----------------- MCP, only from the gateway -------------+
```

Everything except DeepWiki and the chat models runs in the cluster: the store and the platform in namespace `urumi`, each bonus store in `store-<name>`, each hosted server in `mcp-<prefix>`. The MCP servers have no Ingress; NetworkPolicies let only the gateway reach them.

| Component | Code | What it does |
|---|---|---|
| Store | `infra/helm/urumi-store` | WordPress 7.1 + WooCommerce 11.2 + MySQL 8.4, persistent volumes, a WP-CLI Job that installs and configures the shop |
| woo-mcp | `services/woo-mcp` | Our MCP server for the store: list/create products, list/get orders, update order status, over the WooCommerce REST API ([how and why](services/woo-mcp/README.md)) |
| ship-mcp | `services/ship-mcp` | A second MCP server we wrote (shipping quotes and tracking); its `get_order` deliberately collides with woo-mcp's |
| DeepWiki | external | A public MCP server (`https://mcp.deepwiki.com/mcp`), the third upstream |
| platform | `services/platform`, `services/dashboard` | One Node service: the MCP gateway (`/mcp`), the dashboard API (`/api`), the chat agent, and the React dashboard |
| Postgres | `infra/helm/urumi-platform` | Users, sessions, API key hashes, registered servers (credentials encrypted), permissions, audit and activity logs |
| provisioner | `services/platform/src/provisioner.ts`, `infra/images/provisioner` | The only pod with a Kubernetes token: creates and removes hosted servers and bonus stores from rows the dashboard writes, fenced by RBAC and five admission policies ([details](docs/provisioner.md)) |
| Hosted servers | `services/platform/src/provision/hosted.ts`, `infra/images/mcp-bridge` | An admin's MCP server image, run in its own namespace; stdio servers through our bridge |
| Bonus stores | `services/platform/src/provision/stores.ts` | A whole WooCommerce store per namespace, from the same store chart, with its own woo-mcp |

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
| Groq API key | optional | a second LLM provider for chat when Gemini is down, rate-limited or out of quota; free key from console.groq.com. Chat also works with only this key |

### Install

```bash
git clone <this repo> urumi-mcp-gateway && cd urumi-mcp-gateway
make cluster                                   # k3d cluster "urumi-local": Traefik on :9080, NetworkPolicy enforced
make secrets GEMINI_KEY_FILE=~/gemini.key FALLBACK_KEY_FILE=~/groq.key   # creates the Kubernetes Secrets (omit a key file to skip it)
make install                                   # builds our images, installs the store chart, then the platform chart
make hooks                                     # optional: pre-commit check that refuses committed secrets
```

`make install` takes about 5 minutes the first time (it builds the images; the store's setup Job installs WordPress, WooCommerce from a pre-built image checked by SHA-256, and the sample products with their photos). `make up` runs all three steps.

What each step does:
- `scripts/cluster-up.sh` creates (or starts) the k3d cluster: k3s v1.35.5, one server and one agent node, Traefik published on host port 9080. k3s enforces NetworkPolicies itself (kube-router), so the charts' policies are real locally too. It also loads the third-party images from the host into the nodes, because pulls from inside k3d nodes are unreliable on Docker Desktop.
- `scripts/secrets.sh` creates `store-secrets`, `platform-secrets` and `platform-llm` with random values. It never overwrites an existing value, because the databases on the volumes were created with them. The charts only reference these Secrets by name (`secrets.existingSecret`), so no secret is ever in git, in values files or in Helm's release history.
- `make install` builds the images (the gateway with the dashboard, woo-mcp, ship-mcp, the provisioner, the stdio bridge and the WooCommerce zip; tag = the last git commit of their sources), loads them into the nodes, and runs `helm upgrade --install` for both charts with `values-local.yaml`.
- **Without building:** each version tag (`v1.0.0`) publishes the same images to GHCR (`.github/workflows/publish.yml`); add `-f infra/helm/urumi-platform/values-ghcr.yaml` to the platform chart's `helm upgrade --install` to use them.
- **After a Docker restart** the k3d nodes can come back with each other's IP addresses. Run `make install-platform` again: the provisioner's network rule names the API server's address, read at install time.

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

**Claude Code with a browser sign-in instead of a key** (OAuth, MCP authorization spec):
```bash
claude mcp add --transport http urumi http://localhost:9080/mcp      # no header
claude          # in /mcp, authenticate urumi: the browser opens the dashboard; sign in and Allow
```
The whole flow (discovery, registration, PKCE, consent, tokens, refresh, revocation) is tested with the MCP SDK's own OAuth client (`test/oauth-check.mjs`); the interactive Claude Code sign-in is a manual step. The app then appears under **API keys → Connected apps**, where it can be disconnected; its calls are audited under your name, "via Claude Code (OAuth)". MCP clients accept OAuth over plain HTTP only on localhost, which is why the local URL works; on the VPS it is https.

For many servers, connect in tool search mode instead: the client gets two tools, `gateway__search_tools` and `gateway__call_tool`, and finds the rest by keyword (same permissions and audit):
```bash
claude mcp add --transport http urumi-search "http://localhost:9080/mcp?mode=search" --header "Authorization: Bearer urk_..."
```

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

Open **Chat** in the dashboard and ask, for example, "What orders came in today?" or "Create a product called Urumi Tote Bag priced at 799". Each tool call appears as a card with its arguments, result and duration. Anything that changes data (creating a product, changing an order's status) is shown first as a card with the exact call and runs only when you click **Confirm** (`platform.chat.confirmWrites`, on in both values files); an admin can change per tool, on the Servers page, whether chat asks. The agent (Gemini, `gemini-3.5-flash` with `gemini-3.5-flash-lite` as fallback, then optionally Groq `openai/gpt-oss-120b`) acts as the signed-in user: it only gets that user's tools, and every call is in the audit log under that user with source `chat`. If Gemini is overloaded, rate-limited, out of quota or too slow before any tool has run, the answer comes from Groq (the page header names the model that answered) and Gemini rests for 60 s. It needs the `platform-llm` Secret (`make secrets GEMINI_KEY_FILE=... FALLBACK_KEY_FILE=...`); a key given this way replaces the stored one, so a key with a used-up quota can be swapped (then `kubectl rollout restart -n urumi deploy/platform`).

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
1. installs k3s v1.35.5 (same as local) with `--secrets-encryption` (Kubernetes Secrets encrypted at rest in the k3s datastore), puts Traefik on the node's ports 80/443 so each client's real address reaches the gateway (`infra/k3s/traefik-hostport.yaml`), and copies Helm to the node;
2. copies our three images (the tags running locally) into k3s's containerd;
3. ships the charts as committed in git (`git archive HEAD`), never the working tree;
4. runs `scripts/secrets.sh` on the node (the Gemini key travels through a mode-600 temp file that is deleted right after);
5. installs cert-manager v1.21.2 and a Let's Encrypt ClusterIssuer (HTTP-01 through Traefik);
6. installs the store and platform charts with `values-prod.yaml` and the host names below.

**A node installed before Secrets encryption was added** (the flag only applies to a new install): turn it on once, on the node, with k3s's key rotation. On our VPS (k3s v1.35.5) `secrets-encrypt enable` failed and left an "identity" (unencrypted) configuration, which k3s restores from its datastore at every start; these steps worked. Each restart is about 30 seconds without the API and ingress.
```bash
echo "secrets-encryption: true" | sudo tee -a /etc/rancher/k3s/config.yaml
sudo systemctl restart k3s; sleep 40
sudo k3s secrets-encrypt prepare                       # adds an AES-CBC key; status: Enabled, stage prepare
sudo systemctl restart k3s; sleep 40
sudo k3s secrets-encrypt rotate
sudo systemctl restart k3s; sleep 40
sudo k3s secrets-encrypt reencrypt; sleep 30
sudo k3s secrets-encrypt status                        # Enabled, reencrypt_finished, all hashes match
```

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
make netpol-check    # only the NetworkPolicy probes, about 30 s: run before a demo (a Docker restart can leave policies unenforced)
```
Without a cluster (these also run in CI, `.github/workflows/ci.yml`):
```bash
# CI also builds our three images and scans them with Trivy: a fixable CRITICAL fails the build; HIGH and
# third-party images (postgres, mysql, wordpress) are reported only.
node scripts/chart-invariants.mjs   # rendered charts: probes, limits, non-root, API token for the provisioner only, RBAC and admission policies, no Secrets from Helm, internals ClusterIP only
node scripts/values-diff.mjs        # every field that differs between values-local.yaml and values-prod.yaml, and nothing unexpected
(cd services/platform && node test/unit-check.mjs)
```

`scripts/verify-dod.sh` runs against the live cluster and checks the definition of done end to end: storefront and WooCommerce REST; PVCs, probes, limits and security contexts on every container; NetworkPolicies (pods without the gateway's labels cannot reach the MCP servers, databases, WordPress or `/metrics`; the MCP servers and the gateway cannot reach anything but what they need, and no pod holds a Kubernetes API token); keys rejected when missing, invalid or revoked; every enabled server's tools listed with namespaced names; restricted tools hidden and denied; an orders question and a two-server task; disabling a server; killing an upstream pod and stopping it entirely; two-replica behaviour and rate limits; the audit and activity logs. It uses temporary users and removes them and their data afterwards, so it can run on a demo system. Latest results (23 October 2026). **k3d:** `make verify-all` 73 passed, 0 failed, 0 skipped: the provisioner's fence (`rbac-check` 49 of 49), `hosted-check` 7 of 7 (including a stdio server), `stores-check` 12 of 12 (including chat comparing two stores' orders, and the quota and LimitRange), `evil-check` 5 of 5, `credential-isolation-check`, Pod Security `restricted`, pinning, OAuth, scaling, network and the chat checks (including the fallback model). **VPS** (k3s on EC2, over HTTPS, 3 gateway replicas): `verify-dod --all` 71 of 73 suites passed, with hosted servers and bonus stores live there; the two that failed, `features-check` and `evil-check`, failed because of the test, not the product (a replica race in one step; the malicious server's image had not been copied to the node). Both were fixed and then passed on the VPS (14 of 14, 5 of 5). A request that never reached a server is tried once more: from the cluster about 1 connect in 25 to an outside service is dropped.

## Stand-out items and where to find them

| Item from the assignment | What we built | Where |
|---|---|---|
| 1. Production-like VPS deployment | k3s on EC2 with the same charts, TLS from Let's Encrypt, values-only differences (listed field by field by `scripts/values-diff.mjs`) | `infra/scripts/deploy-ec2.sh`, `values-prod.yaml`, [VPS section](#deploy-to-a-vps-k3s) |
| 2. Tool permissions | Per-role rules per server and tool; restricted tools hidden from listing and refused (audited `denied`) for MCP clients and the chat agent alike; editable per tool in the dashboard; members default to tools the server marks read-only (`platform.permissions.memberDefault: readOnly` in both values files), and only for servers whose hints the gateway trusts (the release's own, or ones an admin vouches for), so a new server's tools start admin-only | `services/platform/src/services/permissions.ts`, `src/gateway/mcp.ts` |
| 3. OAuth on the gateway | MCP authorization spec: discovery (RFC 9728, 8414) from the 401, dynamic client registration, PKCE S256, consent in the dashboard, tokens bound to `/mcp` (RFC 8707), rotating refresh tokens with reuse detection, Connected apps with Disconnect. Flag `platform.features.oauth`, on in both values files | `src/services/oauth.ts`, `src/api/oauth.ts`, `test/oauth-check.mjs` |
| 4. Handling many tools | Tool search mode: `/mcp?mode=search` exposes `gateway__search_tools` and `gateway__call_tool`. Flag `platform.features.toolSearch`, on in `values-local.yaml` and `values-prod.yaml` | `src/gateway/mcp.ts` |
| 5. Hosted MCP servers | An admin gives a container image on the Hosted servers page; the provisioner runs it in its own namespace `mcp-<prefix>` with its own Secret (secret env encrypted, a bearer token), quota and limits, restricted Pod Security, and default-deny NetworkPolicies (only the gateway reaches it; it reaches nothing unless allowed the internet), registers it (pinned, hints untrusted), and on delete removes the tools first, then the namespace. The provisioner is the only pod with a Kubernetes token, fenced by RBAC and five admission policies. Details: [docs/provisioner.md](docs/provisioner.md) | `src/provisioner.ts`, `src/provision/`, `templates/provisioner.yaml`, `test/hosted-check.mjs`, `tests/rbac-check.sh` |
| 6. Security hardening | SSRF guard (checked at registration and on every connection; the platform's own hosts and public IP are refused too), default-deny NetworkPolicies with egress lockdown for the MCP servers and the gateway (`make netpol-check`), every container non-root with a read-only root filesystem, and every namespace enforcing Pod Security `restricted` (the app's own namespace too, checked by `verify-dod`), only the provisioner holds a Kubernetes API token, fenced by namespace-scoped RBAC and five admission policies (`tests/rbac-check.sh`: 49 live cases), upstream credentials encrypted with AES-256-GCM, tool pinning: a tool whose title, description, schemas or annotations change is hidden until an admin approves it (flag `platform.features.toolPinning`, on in both values files), hidden-text stripping (TAG and other invisible characters) in descriptions and schemas, no redirects followed to other hosts, committed-secret check | `src/lib/ssrf.ts`, `templates/networkpolicy.yaml`, `src/services/pins.ts`, `scripts/check-secrets.sh` |
| 7. Scaling | Stateless MCP; 2 replicas locally, HPA 2 to 4 on the VPS, PodDisruptionBudget; per-key and per-user rate limits exact across replicas (token buckets in Postgres); at most 8 concurrent calls per upstream; shared sign-in throttling; replicas synchronised through Postgres NOTIFY | `templates/platform-scaling.yaml`, `src/lib/ratelimit.ts` |
| 8. Observability | Prometheus `/metrics` on a private port (calls, errors and latency per server, upstream up, in-flight calls, rejected requests); per-server calls, error rate and p50/p95 latency on the Servers page; unreachable reasons, and the last outage after recovery; a write-ahead audit log (no call without a row) with argument hashes and a spreadsheet-safe CSV export; one request id from the client (`x-request-id`) through the audit row to the MCP server's log; activity log | `src/lib/metrics.ts` |
| 9. Upgrades and rollback | Scripted broken-image upgrade and `helm rollback` with zero failed requests | `scripts/upgrade-rollback-demo.sh` |

Also built, beyond the list:

| What | Why it matters | Where |
|---|---|---|
| Chat asks before any write | Anything that may change data becomes a proposal the user confirms; prompt injection can make the agent propose a change, never make one. The confirmed call goes through the same permission check and audit (`platform.chat.confirmWrites`) | `src/chat/agent.ts`, `src/services/proposals.ts` |
| Read-only hints only from trusted servers | A server's `readOnlyHint` is a claim; it counts only for the release's own servers or ones an admin vouches for, so a hostile server cannot label its tools read-only to reach members or skip confirmation | `src/gateway/upstream-manager.ts` |
| LLM fallback | Chat moves to a second provider (Groq) when Gemini is down, rate-limited or out of quota, only before any tool has run, so a write never runs twice | `src/chat/providers.ts` |
| Append-only audit | The gateway's database role can add and complete audit rows but cannot delete or rewrite them; migrations run as the owner | `src/db/migrate.ts` |

**Bonus: multi-store.** Any user creates stores on the **Stores** page, up to `provisioner.stores.maxPerUser` (2) of their own and `max` in all; they delete their own, admins any. Each is the same `urumi-store` chart in its own namespace `store-<name>` (its own MySQL and volumes, a generated Secret, its own address `<name>.store.<base>`), with its own MCP server registered as `<name>`, so chat and every MCP client reach it as `<name>__list_orders` and so on; status shows Provisioning with the current step, Ready or Failed with the reason, and several are set up in parallel. Delete removes its tools at once, then everything it had. Details and checks: [docs/provisioner.md](docs/provisioner.md#bonus-stores) (`test/stores-check.mjs`).

| Bonus requirement | How | Checked by |
|---|---|---|
| Create and delete from the dashboard; status, URL, created time; several at once | **Stores** page; Provisioning (with the step), Ready, Failed (with the reason); installs run in parallel | `stores-check`: two stores at once |
| Kubernetes-native, own namespace, database, Secrets, volumes, Ingress host | The `urumi-store` chart by Helm in `store-<name>`: its own MySQL, volumes, generated Secret, `<name>.store.<base>` | `stores-check`: each storefront is its own store |
| Automatic MCP registration; tool names name the store | The store's own woo-mcp, registered as `<name>` by the provisioner: `<name>__list_orders` | `stores-check`: each MCP server answers as its store |
| Clean teardown | The tools go in the request; then the namespace with its release, Secret and volumes; the row last | `stores-check`: tools gone, then namespace, volumes and row |
| Isolation with NetworkPolicies | One store's MCP server reaches its own WordPress only, not another store's WordPress or MySQL, nor Postgres | `stores-check`: probes from inside |
| Guardrails | ResourceQuota and LimitRange per store namespace; `maxPerUser` (2) per user and `max` in all; a provisioning timeout (10 min) | `stores-check`, `provision-rows-check` |
| Recovery | Desired-state rows, leases, idempotent steps; a provisioner restart mid-install completes; a failed store says why and can be retried | `stores-check`: provisioner restarted mid-way |
| The bonus test | Chat compares today's orders across two stores; one is deleted and its tools and resources are gone | `stores-check` (P15 steps) |

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

- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md): every requirement of the assignment, the code, and the check that proves it
- [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md): architecture, aggregation and routing, failure handling, production changes
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): credentials, token pass-through, untrusted upstreams, what members can do
- [docs/provisioner.md](docs/provisioner.md): hosted MCP servers and bonus stores, the provisioner and its fence
- [services/woo-mcp/README.md](services/woo-mcp/README.md): how woo-mcp talks to the store, and why
