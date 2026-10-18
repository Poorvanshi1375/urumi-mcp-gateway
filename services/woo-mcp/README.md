# woo-mcp: WooCommerce MCP server

Our own MCP server for the store (no existing Woo MCP server or plugin is used; WooCommerce's
built-in MCP feature is switched off by the store setup Job). It speaks MCP Streamable HTTP at
`/mcp` (MCP TypeScript SDK v2 on Fastify 5) and runs only inside the cluster.

## Tools

| Tool | Input | Woo REST call |
|---|---|---|
| `list_products` | `search?`, `sku?`, `status` (default `any`), `per_page` ≤ 50, `page` | `GET products` |
| `create_product` | `name`, `regular_price` (decimal string), `description?`, `sku?`, `status` (`publish`/`draft`), `stock_quantity?` | `POST products` |
| `list_orders` | `status`, `created_on?` (YYYY-MM-DD, store timezone), `after?`, `before?`, `search?`, `per_page`, `page` | `GET orders` |
| `get_order` | `id` | `GET orders/{id}` |
| `update_order_status` | `id`, `status` (pending, processing, on-hold, completed, cancelled, refunded, failed) | `GET` + `PUT orders/{id}` |

Inputs are validated with zod before any store call. Woo errors (404, 401, timeouts, connection
failures) come back as `isError: true` tool results with a one-line reason; credentials and signed
URLs never appear in results or logs.

## How it talks to the store, and why

**The WooCommerce REST API v3, using the official JS client (`@woocommerce/woocommerce-rest-api`
1.0.2) with OAuth 1.0a one-legged signatures.**

- **Why the REST API.** It is WooCommerce's supported integration surface: product and order
  changes go through Woo's own logic (stock, totals, status transitions, hooks, emails). The
  alternatives were rejected: direct SQL bypasses that logic and would put database credentials
  in this pod; WP-CLI would need the WordPress files or `exec` rights into the WordPress pod.
- **Why OAuth 1.0a and not Basic auth.** Woo accepts consumer key/secret Basic auth only over
  HTTPS (`is_ssl()`). In-cluster traffic is plain HTTP, so requests are signed (HMAC-SHA256)
  with a read/write key that the store setup Job creates (Secret `store-secrets`).
- **The signing detail that matters.** Woo verifies the signature over the WordPress **home URL**
  (`get_home_url()`, scheme and port included), not the Host header or the address we connect to.
  So the client signs with `WC_SIGNING_BASE_URL` (locally `http://store.localhost:9080`) while a
  custom DNS lookup connects to the store's Service (`WC_CONNECT_HOST`,
  `store-wordpress.urumi.svc.cluster.local`), which also listens on the signing URL's port.
  Signing with the Service URL is rejected with HTTP 401 (verified in Gate V2).
- **Why the official JS client.** It signs query values containing `/`, `&`, `~`, `é` and `'`
  correctly (the Python client fails on `/`). Optional parameters are stripped before signing,
  because the client otherwise sends `undefined` values literally.

## Security

- Not exposed outside the cluster: ClusterIP Service, no Ingress, and a NetworkPolicy that admits
  only the gateway's pods (`app=platform` in the same release). Other pods get connection refused.
- Every MCP request must carry `Authorization: Bearer <MCP_BEARER_TOKEN>` (Secret
  `platform-secrets`, key `woo-mcp-token`), compared in constant time. Only the gateway holds it;
  MCP clients never see it.
- Runs as non-root with a read-only root filesystem and no Linux capabilities.

## Configuration

| Env | Meaning |
|---|---|
| `MCP_BEARER_TOKEN` | Token callers must present (required) |
| `WC_SIGNING_BASE_URL` | WordPress home URL used for signing (required; per environment) |
| `WC_CONNECT_HOST` | Host to connect to instead of the signing URL's host (the store Service) |
| `WC_CONSUMER_KEY` / `WC_CONSUMER_SECRET` | Woo REST key (from `store-secrets`) |
| `WC_TIMEOUT_MS` | Per-request timeout to the store (default 15000) |
| `PORT` | Listen port (default 8080) |

`/healthz` is liveness. `/readyz` makes a signed `GET products` (cached 10 s) and returns 503 with
the reason if the store is unreachable or rejects the signature, so a wrong signing URL shows up
as a pod that never becomes Ready.

## Run and test

```bash
# laptop, against the k3d store (Node cannot resolve *.localhost on WSL, so connect to loopback)
export WC_CONSUMER_KEY=$(kubectl get secret -n urumi store-secrets -o jsonpath='{.data.woo-consumer-key}' | base64 -d)
export WC_CONSUMER_SECRET=$(kubectl get secret -n urumi store-secrets -o jsonpath='{.data.woo-consumer-secret}' | base64 -d)
MCP_BEARER_TOKEN=dev WC_SIGNING_BASE_URL=http://store.localhost:9080 WC_CONNECT_HOST=127.0.0.1 PORT=8180 node src/server.ts
MCP_URL=http://127.0.0.1:8180/mcp MCP_BEARER_TOKEN=dev node test/smoke.mjs

# in the cluster (after deploying the urumi-platform chart)
test/run-in-cluster.sh
```

The smoke test creates one draft product with a `TEST-` SKU per run (never on the storefront).
Remove them with `node test/cleanup-test-products.mjs` (same `WC_CONSUMER_KEY`/`WC_CONSUMER_SECRET`
env as above; moves only `TEST-` drafts to the trash).
