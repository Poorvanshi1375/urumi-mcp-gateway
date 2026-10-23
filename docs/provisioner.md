# The provisioner: hosted MCP servers and bonus stores

This covers stand-out item 5 (an admin adds an MCP server by container image and the platform runs it with its own Secret, limits and NetworkPolicy, then removes it cleanly) and, as it lands, the multi-store bonus. It also covers stand-out item 6's rule for any component that talks to the Kubernetes API.

## Shape

```
dashboard --/api--> platform pods (no Kubernetes token)
                      | write desired-state rows (hosted_servers, stores), NOTIFY urumi_provision
                      v
                   Postgres <--- provisioner (own ServiceAccount, own DB role, leases per row)
                                     | Kubernetes API (fetch + its token; RBAC + admission policies)
                                     v
                     mcp-<prefix> / store-<slug> namespaces
                                     | register a managed upstream row, NOTIFY the registry
                                     v
                     the gateway connects and lists its tools: the tenant is Ready
```

- **The gateway never touches Kubernetes.** It faces the internet, so it holds no token: a gateway bug cannot become a cluster takeover. The dashboard's API only writes rows and wakes the provisioner.
- **The provisioner** (`services/platform/src/provisioner.ts`, the same image as the gateway, `node src/provisioner.ts`) is the only pod with a token. It accepts no connections and may connect only to DNS, Postgres and the API server's own address on 6443 (read from the cluster's `kubernetes` EndpointSlice at install time): not the internet, not an MCP server, not a tenant pod.
- **Desired state in Postgres.** A request returns at once; the work survives restarts; status, step and error are visible on the row. Each row is worked on under a **lease** (`lease_owner`, `lease_until`, renewed every 20 s for 60 s; claimed with `FOR UPDATE SKIP LOCKED`), so a crashed provisioner's work is picked up when its lease runs out and two replicas never take the same row. Every write is a **compare-and-set** on the row's state and lease: a Delete that arrives during an install makes the install's next write match nothing, and the install stops.
- **Steps** (`provision/steps.ts`) are idempotent (server-side apply, "create if absent"), so a pass simply runs them again from the top. A step either finishes, waits (a pod still starting; not counted), or fails (retried after 5, 15, 45 s, then `failed`). Past its deadline a waiting row fails with the cluster's own reason, e.g. `ErrImagePull` or `CrashLoopBackOff`. Teardown never gives up: it retries every 45 s at most, with the error shown.

## The fence

RBAC alone is not enough: the provisioner must be able to delete namespaces, and RBAC cannot say "only yours". So the API server enforces the rest with five ValidatingAdmissionPolicies, each matched to the provisioner's account only, `failurePolicy: Fail`, bound with `Deny`:

| Rights (RBAC) | Fence (admission policies) |
|---|---|
| ClusterRole `urumi-provisioner-<ns>`: namespaces (get, list, watch, create, patch, delete), PersistentVolumes (get), rolebindings (create, get, patch, delete), and `bind` on exactly the tenant role | **Namespaces**: only `mcp-<prefix>` or `store-<slug>`, carrying `urumi.dev/managed-by=urumi-provisioner`, `urumi.dev/platform=<release namespace>` and a restricted or baseline Pod Security level, on create and after every update; change or delete only this install's namespaces |
| ClusterRole `urumi-tenant-operator-<ns>`, bound by the provisioner inside one tenant namespace at a time: Secrets, ConfigMaps, Services, PVCs, ServiceAccounts, quotas, Deployments, StatefulSets, Jobs, Ingresses, NetworkPolicies; pods, logs and events read-only; **no Roles or RoleBindings**, so it cannot grant itself more | **Every namespaced write** (`*/*`): the target namespace must carry this install's managed and platform labels, so a role bound elsewhere by mistake still gives nothing |
| Nothing in the platform namespace | **Role bindings**: one fixed name, the tenant role, exactly the provisioner as subject |
| | **Workloads**: no host network, PID or IPC, no hostPath, no privileged containers; ClusterIP Services only |
| | **Images** in `mcp-*`: every container, init and ephemeral image starts with an allowed prefix (`provisioner.hosted.allowedImages`, the same list the API and the provisioner check) |

`tests/rbac-check.sh` proves it live, as the provisioner's account (impersonated): 49 cases, e.g. it cannot read Secrets in the platform namespace or anywhere, bind cluster-admin, create `kube-foo`, delete or relabel a namespace it does not manage, write into another install's namespace even where an admin bound its role, run a privileged or hostPath pod, or run a non-allowed image. `scripts/chart-invariants.mjs` refuses a chart render where another workload holds a token, a role grants `*`, `escalate`, `impersonate` or unnamed `bind`, a cluster binding reaches Secrets, a policy is missing, fails open or only audits, or the provisioner's egress opens another port.

Found and fixed while building it (the P0 spike and live runs): a namespace policy that only checked the old object would have let the provisioner remove its own label and escape; policies on bare pods never fire because the tenant role creates Deployments; a ConfigMap-parameterised image policy never resolved its parameters on k3s v1.35.5 (the list is now written into the expression); the first API egress rule allowed port 443 to the internet.

**Database.** The provisioner connects as `urumi_provisioner`: its own two tables, insert into the activity log, delete of a removed server's permission rules, and on `upstreams`, by row-level security, only the rows it manages. It holds the key that decrypts credentials (it must store each hosted server's token), so it can never read or repoint the woo or ship rows; it has no access to users, keys, sessions, OAuth or the audit log.

## Hosted servers

An admin opens **Hosted servers** and gives a prefix, a name, an image (with a version tag or digest; `:latest` is refused), the port and path it serves MCP on (Streamable HTTP), a size (small 100m/128Mi, medium 250m/256Mi, large 500m/512Mi), env, secret env (encrypted; only names are ever shown again), and whether it needs the internet.

The provisioner then, in `mcp-<prefix>`:

1. checks the image against the allowlist again (it may have changed);
2. creates the namespace (restricted Pod Security, this install's labels, the row's id; a namespace with another owner is never adopted) and its role binding;
3. sets a ResourceQuota (3 pods, twice the size for rolling updates, no PVCs, no NodePort or LoadBalancer Services) and a LimitRange;
4. applies NetworkPolicies: default deny both ways; ingress only from the gateway's pods on the server's port; egress DNS only, plus public 80/443 if the admin asked for the internet;
5. writes the Secret `hosted-env` with the secret env and a bearer token made once and kept;
6. runs the Deployment (non-root uid 1000, no token, read-only root with a small `/tmp`, all capabilities dropped, seccomp) and a ClusterIP Service;
7. registers a managed upstream (`http://mcp.mcp-<prefix>.svc.cluster.local:<port><path>`, bearer token, encrypted) and wakes the gateway;
8. is **Ready when the gateway has connected and listed its tools**: the provisioner never calls the tenant.

Its tools appear on Servers under its prefix, **pinned** and with its read-only hints **not trusted** (it runs someone else's code), so members get none of them by default and chat asks before running any. The gateway may reach exactly that Service: the SSRF guard adds the one host for that upstream only, and the gateway's NetworkPolicy allows only `urumi.dev/role=mcp` pods of this install's namespaces (`tests/tenant-egress-check.sh`).

**Delete** removes the tools from every client at once (the upstream row first), then the namespace and everything in it, then the row.

**stdio servers.** Most published MCP servers speak stdio, not HTTP. With transport `stdio` and a command (for example `node server.js`), an init container copies `mcp-bridge` (infra/images/mcp-bridge: about 200 lines of Go, a 6 MB static binary) into the pod, and the container runs `/bridge/mcp-bridge -- <command>`. The bridge serves MCP over HTTP on the port with the bearer token, runs the command as its child and relays JSON-RPC over its stdin and stdout, one message per line: it remaps request ids so callers never collide in the child's single session, answers repeated `initialize` requests from the first one, refuses lines over 1 MiB, gives each request 30 s, and restarts the child with a growing delay (its health check fails meanwhile). The server's image only needs the command's runtime; the bridge image is on the same allowlist and checked the same way.

A third-party image will not check the bearer token; the NetworkPolicy is the boundary that matters. The token still protects servers that do check it.

**Checked by `services/platform/test/hosted-check.mjs`** (in `scripts/verify-dod.sh --all`): ready from our ship-mcp image in about 30 s; its tools listed and called, audited; a pod in the platform namespace cannot reach it while the gateway can; it cannot reach Postgres, woo-mcp or the internet and has no token; bad images, reserved or taken prefixes and platform env names are refused with the reason; a member gets 403; an image that cannot be pulled ends `failed` with the cluster's reason; delete removes the tools in under a second, then the namespace and the row.

## Bonus stores

Any user opens **Stores**, gives a name (2 to 12 lowercase letters or digits), a title, a currency, a country and a timezone, and gets a complete WooCommerce store in about two minutes, at `http://<name>.<baseHost>` (`<name>.store.localhost:9080` on k3d, `<name>.store.<ip>.nip.io` on the VPS). Several can be created at once. Each user may have `provisioner.stores.maxPerUser` (2) stores of their own, within `max` for the whole install (both counted inside the create's transaction, under the same lock as the name check; 409 with the limit named). The creator and admins may retry or delete a store; everyone sees the list. A store's MCP server is registered for the whole organisation like the default store, so every member gets its read tools: one team, shared stores.

Each store is the **same `urumi-store` chart** as the default store, installed by the provisioner with Helm (`helm upgrade --install`, values only, nothing secret in them) in its own namespace `store-<name>`:

1. the namespace (Pod Security **restricted**: the whole chart passes it), its role binding, a ResourceQuota (8 pods, 3 GiB memory limit, 2 volumes, 10 GiB storage, no NodePort or LoadBalancer Services) and a LimitRange (at most 1 CPU and 1 GiB per container, 5 GiB per volume, defaults for a container without its own);
2. the Secret `store-secrets`, made once and kept (MySQL keeps the first password it was given): MySQL root and user passwords, the WordPress admin password, a WooCommerce REST key and secret, and the token for the store's MCP server; generated in the provisioner, never logged, never stored in Postgres except the MCP token, encrypted on the server row;
3. the chart: MySQL with its volume, WordPress with its volume, the setup Job (WordPress, WooCommerce from the pre-baked image, the REST key on a shop-manager user, sample products), the Ingress host, NetworkPolicies, and the store's **own woo-mcp** (`mcp.enabled`), which talks to its WordPress inside the namespace and accepts only the gateway; a release stuck after a crash (`pending-*`) or failed is removed and installed again;
4. it waits for the setup Job (a failed Job fails the store with its message), then for the MCP server;
5. registers the server `<name>` (bearer token), trusted and not pinned (our own woo-mcp, at an address only the provisioner sets), so members get its read tools like the default store's;
6. is Ready when the gateway has listed its tools.

Its tools are `<name>__list_orders` and so on; results carry `store: { title, url }`, and the chat agent is told that several stores may be connected and never to mix their figures. With many tools (each store adds six), chat switches to `gateway__search_tools` and `gateway__call_tool`; a write sent through `call_tool` is still judged, confirmed and audited as the real tool.

**Delete** needs the store's name typed (it destroys the store's data). The tools go at once, in the request itself; then the namespace, with the Helm release, the Secret and both volumes, and the provisioner waits until the volumes are released before removing the row. A Delete that arrives during an install stops it.

The admin password stays in the cluster: the Stores page shows the store's creator and admins the `kubectl` command that reads it, never the password (the gateway faces the internet and never handles store credentials).

**Checked by `services/platform/test/stores-check.mjs`** (in `scripts/verify-dod.sh --all`): two stores created at the same time are both Ready (about four minutes in parallel on a laptop) even with the provisioner restarted mid-way, with no duplicate rows; each storefront serves its own store; each store's MCP server answers as that store; a product created in one is not listed by the other; one store's MCP server reaches its own WordPress but not the other store's WordPress or MySQL, nor Postgres, and their secrets differ (compared by hash); each store namespace has its quota and LimitRange (a 2 GiB container is refused); the limit refuses one store too many; a store deleted during its install is removed; **chat compares today's orders across two stores** (one order placed today in one, two in the other: chat must call `list_orders` on both and give each store's total), and after one store is deleted chat's tools and a tool search no longer include it; a member sees others' stores without actions or the password command and gets 403 on them, creates and deletes their own, and another member gets 403 on it; deleting a store removes its tools in under a second, then its namespace, volumes and row. The per-user limit is checked against the real database by `provision-rows-check` (a third store refused, a store being deleted not counted, the overall limit applied first).

## Limits

- `provisioner.hosted.maxServers` (5) hosted servers; each must be ready within `timeoutMinutes` (3).
- `provisioner.stores.max` bonus stores (3 on k3d, 2 on the 8 GiB VPS: each takes about 0.6 GiB of requests), at most `maxPerUser` (2) per user; each must be ready within `timeoutMinutes` (10).
- Bonus stores are served over plain http (Let's Encrypt per store on nip.io is possible but rate-limited; not enabled).
- One provisioner replica (leases would make two safe).
- stdio servers run through the bridge, one session for all callers: servers that keep per-client state are not separated per caller.
- The API server's address is read at install time; if the node's address changes, run `helm upgrade` again.
