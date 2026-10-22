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

A third-party image will not check the bearer token; the NetworkPolicy is the boundary that matters. The token still protects servers that do check it.

**Checked by `services/platform/test/hosted-check.mjs`** (in `scripts/verify-dod.sh --all`): ready from our ship-mcp image in about 30 s; its tools listed and called, audited; a pod in the platform namespace cannot reach it while the gateway can; it cannot reach Postgres, woo-mcp or the internet and has no token; bad images, reserved or taken prefixes and platform env names are refused with the reason; a member gets 403; an image that cannot be pulled ends `failed` with the cluster's reason; delete removes the tools in under a second, then the namespace and the row.

## Bonus stores

In progress (steps P8 to P11): each store is the same `urumi-store` chart in `store-<slug>`, with its own MySQL, generated Secret and Ingress host, plus its own woo-mcp registered as a managed upstream (trusted and not pinned: our code, at an address only the provisioner sets).

## Limits

- `provisioner.hosted.maxServers` (5) hosted servers; each must be ready within `timeoutMinutes` (3).
- One provisioner replica (leases would make two safe).
- Only HTTP servers; stdio servers would need a bridge (optional step P12).
- The API server's address is read at install time; if the node's address changes, run `helm upgrade` again.
