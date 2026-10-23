#!/usr/bin/env bash
# Automated definition-of-done checks against the running cluster (namespace urumi).
#
#   scripts/verify-dod.sh            store, Kubernetes, network isolation, the DoD flow, and the
#                                    existing suites (gateway-check, api-check, in-cluster MCP smoke)
#   scripts/verify-dod.sh --quick    skip the existing suites
#   scripts/verify-dod.sh --all      also chat-check (uses the Gemini quota) and the slow-upstream test
#   scripts/verify-dod.sh --keep     keep the temporary users and their audit rows for inspection
#   scripts/verify-dod.sh --netpol   only the network isolation probes (about 30 s; run before recording)
# Another cluster (e.g. the VPS through an SSH tunnel): set KUBECONFIG, GW_URL and STORE_URL.
#
# It never touches the demo users or demo data: it creates temporary users vdod-*@example.com with
# their own keys, and on exit removes them, their audit and activity rows, rows from unauthenticated test
# requests made during the run, users created by api-check, and TEST draft products.
# Steps that cannot be automated (the storefront checkout by hand, a Claude Code session) are described
# in the README under "Use it" and "Check that it works".
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
NS=${NS:-urumi}
GW_URL=${GW_URL:-http://localhost:9080}
STORE_URL=${STORE_URL:-http://store.localhost:9080}
# Node gives each address only 250 ms to connect; a far-away gateway (India -> Sydney ~300 ms) then
# fails with ETIMEDOUT although curl works. Same setting as the platform image.
export NODE_OPTIONS="${NODE_OPTIONS:-} --network-family-autoselection-attempt-timeout=2000"
QUICK=0; ALL=0; KEEP=0; NETPOL=0
for a in "$@"; do case $a in --quick) QUICK=1;; --all) ALL=1;; --keep) KEEP=1;; --netpol) NETPOL=1; QUICK=1;; *) echo "unknown option $a"; exit 2;; esac; done

PASSES=0; FAILS=0; SKIPS=0; FAILED_NAMES=()
pass() { PASSES=$((PASSES+1)); printf 'PASS  %-56s %s\n' "$1" "${2:-}"; }
fail() { FAILS=$((FAILS+1)); FAILED_NAMES+=("$1"); printf 'FAIL  %-56s %s\n' "$1" "${2:-}"; }
skip() { SKIPS=$((SKIPS+1)); printf 'SKIP  %-56s %s\n' "$1" "${2:-}"; }
section() { printf '\n=== %s\n' "$*"; }
# Run a whole suite; it prints its own PASS/FAIL lines, and counts here as one result.
suite() { local name=$1; shift; section "suite: $name"; if "$@"; then pass "suite $name"; else fail "suite $name" "see its output above"; fi; }

CLI=(kubectl exec -n "$NS" deploy/platform -c platform -- node src/cli.ts)
psql_exec() { kubectl exec -n "$NS" platform-postgres-0 -- sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -qAt -c \"$1\""; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log($1)})"; }
secret() { kubectl get secret -n "$NS" "$1" -o jsonpath="{.data.$2}" | base64 -d; }

TS=$(date +%s)
START_SQL=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ADMIN_EMAIL="vdod-admin-$TS@example.com"
MEMBER_EMAIL="vdod-member-$TS@example.com"
MEMBER2_EMAIL="vdod-member2-$TS@example.com"
ADMIN_PW="vdod-$(openssl rand -hex 12)"
TMP=$(mktemp -d)
LATENCY_CHANGED=0
FALLBACK_FORCED=0

cleanup() {
  section "cleanup"
  "${CLI[@]}" upstreams enable ship >/dev/null 2>&1 && echo "ship enabled"
  [ "$(kubectl get deploy -n "$NS" platform-ship-mcp -o jsonpath='{.spec.replicas}' 2>/dev/null)" = 0 ] && kubectl scale -n "$NS" deploy/platform-ship-mcp --replicas=1 >/dev/null && echo "ship-mcp scaled back to 1"
  if [ $LATENCY_CHANGED = 1 ]; then NS=$NS tests/ship-latency.sh 0; kubectl set env -n "$NS" deploy/platform-ship-mcp TOOL_DESCRIPTION_SUFFIX="" TOOL_ANNOTATIONS_OVERRIDE="" ECHO_REQUEST_TOOL- >/dev/null 2>&1; fi
  kubectl delete pod -n "$NS" -l vdod=probe --ignore-not-found --wait=false >/dev/null 2>&1
  kubectl delete ns -l vdod=nptest --ignore-not-found --wait=false >/dev/null 2>&1   # tenant-egress-check's stand-ins
  kubectl delete ns store-vdodrb mcp-vdodrb vdod-victim store-vdodot --ignore-not-found --wait=false >/dev/null 2>&1   # rbac-check's
  if [ $FALLBACK_FORCED = 1 ]; then kubectl set env -n "$NS" deploy/platform -c platform CHAT_FORCE_FALLBACK- >/dev/null 2>&1 && echo "CHAT_FORCE_FALLBACK removed"; fi
  if [ $KEEP = 1 ]; then echo "--keep: temporary users $ADMIN_EMAIL, $MEMBER_EMAIL, $MEMBER2_EMAIL kept"; else
    psql_exec "begin;
      delete from audit_events where user_id in (select id from users where email like 'vdod-%@example.com' or email like 'invitee-%@example.com');
      delete from audit_events where user_id is null and created_at >= '$START_SQL';
      delete from activity_events where actor_email like 'vdod-%@example.com' or actor_email like 'invitee-%@example.com'
        or target like 'vdod-%@example.com' or target like 'invitee-%@example.com' or target in ('shipcopy', 'shippin')
        or (created_at >= '$START_SQL' and (actor_id is null or actor_email = 'cli'));
      delete from invites where email like 'invitee-%@example.com' or email = 'x@example.com';
      delete from users where email like 'vdod-%@example.com' or email like 'invitee-%@example.com';
      delete from upstreams where prefix in ('shipcopy', 'shippin', 'vdodmgd', 'vdodplant');
      delete from hosted_servers where prefix like 'vdodl%';
      update hosted_servers set state = 'deleting', next_attempt_at = null where prefix in ('vdodev', 'vdodbad', 'vdodevil', 'vdodstdio') and state <> 'deleting';
      update stores set state = 'deleting', next_attempt_at = null where slug in ('vdodaa', 'vdodbb', 'vdodcc', 'vdoddd') and state <> 'deleting';   -- stores-check's   -- hosted-check's, if it stopped early   -- test registrations, if a suite stopped early
      delete from oauth_clients where name like 'oauth-check%';         -- and oauth-check's clients (their grants go with them)
      commit;" && echo "temporary users, their keys and audit rows removed"
    if [ $QUICK = 0 ] || [ $ALL = 1 ]; then
      # Signs over the store's public URL and connects to it (127.0.0.1 for the local k3d store).
      host=${STORE_URL#*://}; host=${host%%[:/]*}; [ "$host" = store.localhost ] && host=127.0.0.1
      (cd services/woo-mcp && WC_SIGNING_BASE_URL=$STORE_URL WC_CONNECT_HOST=$host \
        WC_CONSUMER_KEY=$(secret store-secrets woo-consumer-key) WC_CONSUMER_SECRET=$(secret store-secrets woo-consumer-secret) \
        node test/cleanup-test-products.mjs 2>&1 | tail -1)
    fi
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# Network isolation probes; also run alone with --netpol (make netpol-check) before a demo, since a
# Docker or laptop restart can bring the cluster back without NetworkPolicy enforcement.
network_checks() {
  section "network isolation: default deny; only the gateway reaches upstreams, only Traefik and woo-mcp reach WordPress"
  # kube-router adds a new pod's IP to the allow sets a few seconds after it starts: wait 8 s.
  probe() { # name, labels, targets
    kubectl run "$1" -n "$NS" --labels="vdod=probe,$2" --restart=Never --image=busybox:1.37 \
      --overrides='{"spec":{"containers":[{"name":"'"$1"'","image":"busybox:1.37","command":["sh","-c","sleep 8; for t in '"$3"'; do h=${t%:*}; p=${t#*:}; if nc -w 3 -z $h $p; then echo $t REACHABLE; else echo $t BLOCKED; fi; done"],"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"100m","memory":"32Mi"}}}]}}' >/dev/null
  }
  # /metrics is on the gateway pods' own port (no Service, no Ingress): probe a pod IP directly.
  GW_POD_IP=$(kubectl get pod -n "$NS" -l app=platform,app.kubernetes.io/instance=platform --field-selector=status.phase=Running -o jsonpath='{.items[0].status.podIP}')
  probe "vdod-intruder-$TS" "app=intruder" "platform-woo-mcp:8080 platform-ship-mcp:8080 platform-postgres:5432 store-mysql:3306 store-wordpress:80 platform:80 ${GW_POD_IP}:9464"
  probe "vdod-gateway-$TS" "app=platform,app.kubernetes.io/instance=platform" "platform-woo-mcp:8080 platform-ship-mcp:8080"
  for p in "vdod-intruder-$TS" "vdod-gateway-$TS"; do kubectl wait pod/"$p" -n "$NS" --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s >/dev/null 2>&1; done
  while read -r t r; do [ "$r" = BLOCKED ] && pass "pod without gateway labels -> $t" "$r" || fail "pod without gateway labels -> $t" "${r:-no result}"; done < <(kubectl logs -n "$NS" "vdod-intruder-$TS" 2>&1)
  while read -r t r; do [ "$r" = REACHABLE ] && pass "control: pod with gateway labels -> $t" "$r" || fail "control: pod with gateway labels -> $t" "${r:-no result}"; done < <(kubectl logs -n "$NS" "vdod-gateway-$TS" 2>&1)
  kubectl delete pod -n "$NS" "vdod-intruder-$TS" "vdod-gateway-$TS" --wait=false >/dev/null 2>&1
  # Egress from the MCP servers: woo-mcp may reach only DNS and WordPress; ship-mcp nothing at all.
  egress() { # deployment, expected result, targets...
    local d=$1 want=$2; shift 2
    for t in "$@"; do
      r=$(kubectl exec -n "$NS" "deploy/$d" -- sh -c "nc -w 3 -z ${t%:*} ${t#*:} && echo REACHABLE || echo BLOCKED" 2>/dev/null)
      [ "$r" = "$want" ] && pass "egress $d -> $t" "$r" || fail "egress $d -> $t" "${r:-no result} (want $want)"
    done
  }
  egress platform-woo-mcp BLOCKED platform-ship-mcp:8080 platform-postgres:5432 store-mysql:3306 1.1.1.1:443
  egress platform-woo-mcp REACHABLE store-wordpress:80
  egress platform-ship-mcp BLOCKED platform-woo-mcp:8080 store-wordpress:80 1.1.1.1:443
  # The gateway: only DNS, Postgres, our MCP servers and public 80/443. The Kubernetes API (via its
  # Service), the store's pods and private addresses are refused by the network as well as the SSRF guard.
  egress platform BLOCKED kubernetes.default:443 store-mysql:3306 store-wordpress:80 169.254.169.254:80
  egress platform REACHABLE platform-postgres:5432 platform-woo-mcp:8080 platform-ship-mcp:8080 1.1.1.1:443
  # Into the provisioner's namespaces (P3, provisioner.enabled): only their MCP pod, of this install.
  if kubectl get networkpolicy -n "$NS" platform-gateway -o json 2>/dev/null | grep -q 'urumi.dev/managed-by'; then
    while read -r line; do
      case $line in PASS*) pass "${line#PASS  }" "";; FAIL*) fail "${line#FAIL  }" "";; esac
    done < <(NS=$NS tests/tenant-egress-check.sh 2>&1)
  else
    skip "gateway egress into tenant namespaces" "provisioner.enabled is off: no such rule"
  fi
}

section "preflight"
kubectl get deploy -n "$NS" platform >/dev/null 2>&1 || { echo "no platform deployment in namespace $NS (is the cluster up?)"; exit 1; }
[ -d services/platform/node_modules ] || { echo "run: (cd services/platform && npm ci)"; exit 1; }
echo "context $(kubectl config current-context), namespace $NS, gateway $GW_URL, store $STORE_URL"
if [ $NETPOL = 1 ]; then
  network_checks
  section "summary"; echo "$PASSES passed, $FAILS failed"; for n in "${FAILED_NAMES[@]}"; do echo "  failed: $n"; done
  [ $FAILS = 0 ] && echo "NETPOL-CHECK PASSED" || echo "NETPOL-CHECK FAILED"; exit $((FAILS > 0))
fi

suite "unit-check (names, caps, delimiter, routing; no cluster)" env -C services/platform node test/unit-check.mjs

# ---------------------------------------------------------------------------------------------
section "store (D1 prerequisites)"
code=$(curl -s -o "$TMP/shop.html" -w '%{http_code}' "$STORE_URL/shop/")
if [ "$code" = 200 ] && grep -q 'woocommerce' "$TMP/shop.html"; then pass "storefront /shop/ responds" "HTTP 200, WooCommerce page"; else fail "storefront /shop/ responds" "HTTP $code"; fi
n=$(curl -s "$STORE_URL/wp-json/wc/store/v1/products" | json 'v.length' 2>/dev/null)
if [ "${n:-0}" -ge 1 ] 2>/dev/null; then pass "WooCommerce REST (Store API) responds" "$n published products"; else fail "WooCommerce REST (Store API) responds" "got: ${n:-nothing}"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' "$STORE_URL/wp-login.php")
[ "$code" = 200 ] && pass "wp-admin login page" "HTTP 200" || fail "wp-admin login page" "HTTP $code"
# The WooCommerce REST key belongs to the shop_manager service user, never an administrator (AA).
owner=$(kubectl exec -i -n "$NS" store-mysql-0 -- sh -c 'mysql -N -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" 2>/dev/null' <<'SQL'
select concat(u.user_login, ' ', m.meta_value) from wp_woocommerce_api_keys k
  join wp_users u on u.ID = k.user_id join wp_usermeta m on m.user_id = u.ID and m.meta_key = 'wp_capabilities'
  where k.description = 'urumi-mcp';
SQL
)
if grep -q shop_manager <<<"$owner" && ! grep -q administrator <<<"$owner"; then pass "WooCommerce key owned by a shop_manager, not an admin" "${owner%% *}"; else fail "WooCommerce key owned by a shop_manager, not an admin" "${owner:-no key found}"; fi
# The setup Job migrates the WordPress and WooCommerce databases itself (AI).
upg=$(kubectl logs -n "$NS" job/store-setup 2>/dev/null | grep -cE "Success: (WordPress database|.*Database version|.*updated)")
[ "${upg:-0}" -ge 2 ] && pass "store setup ran the database upgrades" "WordPress and WooCommerce" || fail "store setup ran the database upgrades" "found ${upg:-0} of 2 in the setup Job log"

# ---------------------------------------------------------------------------------------------
section "kubernetes"
bound=$(kubectl get pvc -n "$NS" -o json | json "v.items.map(p=>p.metadata.name+':'+p.status.phase).join(' ')")
if [ -n "$bound" ] && ! grep -qv ':Bound' <<<"${bound// /$'\n'}"; then pass "PVCs bound (MySQL, wp-content, Postgres)" "$bound"; else fail "PVCs bound" "$bound"; fi
k7=$(kubectl get pods -n "$NS" -o json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const bad=[];let n=0;
for (const p of JSON.parse(s).items) { if (p.metadata.labels?.vdod) continue; const job=(p.metadata.ownerReferences??[]).some(o=>o.kind==="Job");
  for (const c of [...(p.spec.initContainers??[]),...p.spec.containers]) { n++; const r=c.resources??{}; const init=(p.spec.initContainers??[]).includes(c);
    if (!r.requests?.cpu||!r.requests?.memory||!r.limits?.cpu||!r.limits?.memory) bad.push(p.metadata.name+"/"+c.name+": resources");
    if (!job&&!init&&(!c.readinessProbe||!c.livenessProbe)) bad.push(p.metadata.name+"/"+c.name+": probes"); } }
console.log(bad.length?"BAD "+bad.join(", "):"OK "+n+" containers");});')
[[ $k7 == OK* ]] && pass "probes, requests and limits on every workload" "${k7#OK }" || fail "probes, requests and limits on every workload" "${k7#BAD }"
# Every container: non-root, no privilege escalation, all capabilities dropped, seccomp RuntimeDefault;
# every pod: no Kubernetes API token mounted.
sec=$(kubectl get pods -n "$NS" -o json | node scripts/lib/pod-security.mjs)
[[ $sec == OK* ]] && pass "non-root, no escalation, caps dropped, seccomp, no API token" "${sec#OK }" || fail "non-root, no escalation, caps dropped, seccomp, no API token" "${sec#BAD }"
# Append-only audit (AC): the role the gateway runs as cannot delete or rewrite audit rows, while
# completing rows and the foreign-key nulling on deletes still work. Run as that role, in Postgres.
APP_ROLE=$(kubectl get deploy -n "$NS" platform -o jsonpath='{.spec.template.spec.containers[?(@.name=="platform")].env[?(@.name=="PGUSER")].value}')
as_app() { kubectl exec -i -n "$NS" platform-postgres-0 -- sh -c "psql -U '$APP_ROLE' -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -qAt" 2>&1; }
if [ -n "$APP_ROLE" ] && [ "$APP_ROLE" != "$(kubectl get deploy -n "$NS" platform -o jsonpath='{.spec.template.spec.initContainers[0].env[?(@.name=="PGUSER")].value}')" ]; then
  del=$(as_app <<<"delete from audit_events where id = (select max(id) from audit_events);")
  rew=$(as_app <<<"update audit_events set user_id = null, request_id = 'x' where id = (select max(id) from audit_events);")
  fk=$(as_app <<'SQL'
begin;
insert into users (email, role) values ('vdod-ac-fk@example.com', 'member');
insert into audit_events (user_id, tool, outcome) select id, 'ac_check', 'ok' from users where email = 'vdod-ac-fk@example.com';
delete from users where email = 'vdod-ac-fk@example.com';
select count(*) from audit_events where tool = 'ac_check' and user_id is null;
rollback;
SQL
)
  if grep -q "permission denied" <<<"$del" && grep -q "permission denied" <<<"$rew" && [ "$(tail -1 <<<"$fk")" = 1 ]; then
    pass "audit is append-only for the app role ($APP_ROLE)" "delete and rewrite refused; user deletion still nulls user_id"
  else fail "audit is append-only for the app role ($APP_ROLE)" "delete: ${del:0:60} | rewrite: ${rew:0:60} | fk: ${fk:0:80}"; fi
else fail "audit is append-only for the app role" "the gateway connects as the owner (postgres.appUser unset)"; fi
routes=$(kubectl get ingress -A -o json | json "v.items.flatMap(i=>i.spec.rules.flatMap(r=>r.http.paths.map(p=>(r.host||'*')+'->'+p.backend.service.name))).join(' ')")
if grep -qE 'mcp|postgres|mysql' <<<"$routes"; then fail "Ingress exposes only the store and the platform" "$routes"; else pass "Ingress exposes only the store and the platform" "$routes"; fi

# ---------------------------------------------------------------------------------------------
network_checks

# ---------------------------------------------------------------------------------------------
section "temporary users and keys"
key_for() { "${CLI[@]}" keys create "$1" "$2" | json 'v.key'; }
# Each suite gets its own admin key: the per-key rate limit (120/min) is exact across replicas, so
# suites sharing one key would spend each other's budget, which separate real clients never do.
"${CLI[@]}" users add "$ADMIN_EMAIL" admin "$ADMIN_PW" >/dev/null && "${CLI[@]}" users add "$MEMBER_EMAIL" member >/dev/null && "${CLI[@]}" users add "$MEMBER2_EMAIL" member >/dev/null \
  || { fail "create temporary users"; exit 1; }
KEY_ADMIN=$(key_for "$ADMIN_EMAIL" vdod); KEY_MEMBER=$(key_for "$MEMBER_EMAIL" vdod); KEY_MEMBER2=$(key_for "$MEMBER2_EMAIL" vdod)
[[ $KEY_ADMIN == urk_* && $KEY_MEMBER == urk_* && $KEY_MEMBER2 == urk_* ]] && echo "created $ADMIN_EMAIL (admin), $MEMBER_EMAIL and $MEMBER2_EMAIL (members), one key each" || { fail "create temporary keys"; exit 1; }

# ---------------------------------------------------------------------------------------------
section "managed upstreams and the provisioner's database role (P2)"
# A disabled fake managed row (as the provisioner would register a hosted server): the gateway never
# connects to it. The API and the CLI must refuse to change its address or credential or to delete it.
MGD=vdodmgd
psql_exec "delete from upstreams where prefix = '$MGD'; insert into upstreams (prefix, name, url, auth_type, enabled, managed_by, managed_id)
  values ('$MGD', 'Managed check', 'http://mcp.mcp-$MGD.svc.cluster.local:8080/mcp', 'none', false, 'hosted', gen_random_uuid());" >/dev/null
api() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "$GW_URL$2" -H "authorization: Bearer $KEY_ADMIN" ${3:+-H 'content-type: application/json' -d "$3"}; }
c_cred=$(api PATCH /api/servers/$MGD '{"authType":"bearer","credential":"x"}'); c_url=$(api PATCH /api/servers/$MGD '{"url":"https://example.com/mcp"}')
c_del=$(api DELETE /api/servers/$MGD); c_name=$(api PATCH /api/servers/$MGD '{"name":"Managed check renamed"}')
c_cli=$("${CLI[@]}" upstreams remove $MGD 2>&1 | grep -m1 "managed by")
left=$(psql_exec "select count(*) || ' ' || max(url) from upstreams where prefix = '$MGD'")
if [ "$c_cred $c_url $c_del $c_name" = "409 409 409 200" ] && grep -q "managed by" <<<"$c_cli" && [[ $left == "1 http://mcp.mcp-$MGD."* ]]; then
  pass "managed rows: address, credential and delete refused (API and CLI)" "credential $c_cred, url $c_url, delete $c_del; rename $c_name; CLI: ${c_cli:0:70}"
else fail "managed rows: address, credential and delete refused (API and CLI)" "credential $c_cred url $c_url delete $c_del rename $c_name | CLI: ${c_cli:0:80} | row: $left"; fi
# The provisioner's role: its tables and the managed rows only (row-level security), nothing else.
PROV_ROLE=$(kubectl get deploy -n "$NS" platform -o jsonpath='{.spec.template.spec.initContainers[0].env[?(@.name=="PROVISIONER_DB_USER")].value}')
as_role() { kubectl exec -i -n "$NS" platform-postgres-0 -- sh -c "psql -U '$1' -d \"\$POSTGRES_DB\" -qAt" 2>&1; }
if [ -n "$PROV_ROLE" ] && [ "$(psql_exec "select count(*) from pg_roles where rolname = '$PROV_ROLE'")" = 1 ]; then
  WOO_URL=$(psql_exec "select url from upstreams where prefix = 'woo'")
  seen=$(as_role "$PROV_ROLE" <<<"select count(*) || '/' || count(*) filter (where managed_by is null) from upstreams;")
  secret_tables=$(for t in users api_keys sessions audit_events oauth_grants chat_proposals tool_pins; do as_role "$PROV_ROLE" <<<"select 1 from $t limit 1;" | grep -q "permission denied" && echo -n "$t "; done)
  # psql -q prints no command tags: count the rows the update reached instead.
  repoint=$(as_role "$PROV_ROLE" <<<"with u as (update upstreams set url = 'http://attacker.example/mcp' where prefix = 'woo' returning 1) select count(*) from u;")
  plant=$(as_role "$PROV_ROLE" <<<"insert into upstreams (prefix, name, url) values ('vdodplant', 'x', 'http://x/mcp');")
  own=$(as_role "$PROV_ROLE" <<<"begin; insert into activity_events (action, target) values ('vdod_check', 'x'); select count(*) from hosted_servers; update upstreams set name = name where prefix = '$MGD'; rollback;")
  app_seen=$(as_role "$APP_ROLE" <<<"select count(*) filter (where managed_by is null) from upstreams;")
  if [ "$seen" = "1/0" ] && [ "$secret_tables" = "users api_keys sessions audit_events oauth_grants chat_proposals tool_pins " ] && [ "$repoint" = "0" ] \
    && [ "$(psql_exec "select url from upstreams where prefix = 'woo'")" = "$WOO_URL" ] && grep -q "row-level security" <<<"$plant" && ! grep -qi "error" <<<"$own" && [ "${app_seen:-0}" -ge 3 ]; then
    pass "provisioner role ($PROV_ROLE): its rows only" "sees 1 managed row of all servers, 0 others; no access to ${secret_tables% }; cannot repoint woo or plant a server; app role still sees $app_seen"
  else fail "provisioner role ($PROV_ROLE): its rows only" "seen $seen | denied: $secret_tables | repoint: $repoint | plant: ${plant:0:80} | own: ${own:0:80} | app sees $app_seen"; fi
else fail "provisioner role" "role ${PROV_ROLE:-(unset)} does not exist (run make secrets to add provisioner-db-password, then make install)"; fi
psql_exec "delete from upstreams where prefix in ('$MGD', 'vdodplant')" >/dev/null
# H1/H2: leases and compare-and-set writes on the provisioner's rows, against this Postgres, through
# the real module inside a gateway pod (the image has src/, not test/).
suite "provision-rows-check (leases, compare-and-set)" bash -c "kubectl exec -i -n '$NS' deploy/platform -c platform -- node --input-type=module < services/platform/test/provision-rows-check.mjs"

# ---------------------------------------------------------------------------------------------
# The provisioner (P4): running, connected as its own role, reaching only DNS, Postgres and the
# Kubernetes API, and fenced at the API server (rbac-check).
if kubectl get deploy -n "$NS" platform-provisioner >/dev/null 2>&1; then
  section "the provisioner (P4)"
  if kubectl rollout status -n "$NS" deploy/platform-provisioner --timeout=120s >/dev/null 2>&1; then
    pass "provisioner Ready" "$(kubectl get pod -n "$NS" -l app=provisioner -o jsonpath='{.items[0].metadata.name}')"
  else fail "provisioner Ready" "$(kubectl get pod -n "$NS" -l app=provisioner -o wide 2>&1 | tail -1)"; fi
  plog=$(kubectl logs -n "$NS" deploy/platform-provisioner --tail=50 2>&1)
  grep -q '"provisioner connected"' <<<"$plog" && pass "provisioner reached Postgres (as $(kubectl get deploy -n "$NS" platform-provisioner -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PGUSER")].value}')) and the Kubernetes API" "" \
    || fail "provisioner connected" "$(tail -2 <<<"$plog" | cut -c1-200)"
  # Its egress, from inside its pod. kube-router rejects denied traffic, which looks like "nothing
  # listening"; these targets are all up in this run (the network checks above reach woo-mcp,
  # ship-mcp and WordPress, and the store's checks need MySQL), so a refusal here is the policy's.
  preach() { kubectl exec -n "$NS" deploy/platform-provisioner -- node -e '
    const s = require("net").connect({ host: process.argv[1], port: Number(process.argv[2]), timeout: 3000 }, () => { console.log("REACHABLE"); s.destroy(); });
    s.on("timeout", () => { console.log("BLOCKED"); s.destroy(); }); s.on("error", () => console.log("BLOCKED"));' "$1" "$2" 2>/dev/null; }
  for t in kubernetes.default:443 platform-postgres:5432; do
    r=$(preach "${t%:*}" "${t#*:}"); [ "$r" = REACHABLE ] && pass "provisioner -> $t" "$r" || fail "provisioner -> $t" "${r:-no result} (want REACHABLE)"
  done
  for t in platform-woo-mcp:8080 platform-ship-mcp:8080 store-mysql:3306 store-wordpress:80 1.1.1.1:443 8.8.8.8:6443; do
    r=$(preach "${t%:*}" "${t#*:}")
    if [ "$r" = BLOCKED ]; then pass "provisioner -> $t" "BLOCKED"; else fail "provisioner -> $t" "${r:-no result} (want BLOCKED)"; fi
  done
  suite "rbac-check (the provisioner's fence at the API server)" env NS="$NS" tests/rbac-check.sh
else
  skip "the provisioner" "provisioner.enabled is off"
fi

# The order-based checks need at least one order. On an empty store (a fresh install), place one
# through the Store API exactly like the checkout page does (cash on delivery).
mcp_call() { curl -s -X POST "$GW_URL/mcp" -H "authorization: Bearer $KEY_ADMIN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d "$1" | sed -n 's/^data: //p;t;/^{/p'; }
latest_order() { mcp_call '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"woo__list_orders","arguments":{"per_page":1}}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(JSON.parse(s).result.content[0].text).orders[0];console.log(o?o.id+" "+o.date_created.slice(0,10):"")}catch{console.log("")}})'; }
LATEST=$(latest_order)
if [ -z "$LATEST" ]; then
  section "the store has no orders: placing one through the Store API (cash on delivery)"
  STORE_URL="$STORE_URL" node tests/place-order.mjs && LATEST=$(latest_order)
fi
read -r ORDER_ID ORDER_DAY <<<"$LATEST"
echo "newest order: #${ORDER_ID:-none} (${ORDER_DAY:-})"

# ---------------------------------------------------------------------------------------------
suite "dod-check (D4-D9 through /mcp and the dashboard API)" \
  env -C services/platform/test GW_URL="$GW_URL" NS="$NS" KEY_ADMIN="$KEY_ADMIN" KEY_MEMBER="$KEY_MEMBER" ADMIN_EMAIL="$ADMIN_EMAIL" MEMBER_EMAIL="$MEMBER_EMAIL" node dod-check.mjs

REPLICAS=$(kubectl get deploy -n "$NS" platform -o jsonpath='{.status.readyReplicas}')
if [ "${REPLICAS:-1}" -ge 2 ]; then
  KEY_MEMBER4=$(key_for "$MEMBER2_EMAIL" vdod-scaling)
  suite "scaling-check ($REPLICAS gateway replicas)" env -C services/platform/test GW_URL="$GW_URL" NS="$NS" KEY_ADMIN="$(key_for "$ADMIN_EMAIL" vdod-scaling)" KEY_MEMBER="$KEY_MEMBER4" node scaling-check.mjs
else
  skip "scaling-check" "the gateway runs ${REPLICAS:-1} replica"
fi

FEAT=$(curl -s -H "authorization: Bearer $KEY_ADMIN" "$GW_URL/api/features")
if grep -q true <<<"$FEAT"; then
  # A fresh member key: dod-check revoked the first one.
  KEY_MEMBER3=$(key_for "$MEMBER2_EMAIL" vdod-features)
  suite "features-check ($FEAT)" env -C services/platform/test GW_URL="$GW_URL" NS="$NS" KEY_ADMIN="$(key_for "$ADMIN_EMAIL" vdod-features-admin)" KEY_MEMBER="$KEY_MEMBER3" MEMBER_EMAIL="$MEMBER2_EMAIL" \
    SHIP_URL="http://platform-ship-mcp.$NS.svc.cluster.local:8080/mcp" SHIP_TOKEN="$(secret platform-secrets ship-mcp-token)" node features-check.mjs
  LATENCY_CHANGED=1   # it changes ship-mcp's env; cleanup puts the test knobs back
else
  skip "features-check" "tool pinning and search mode are off"
fi
if grep -q '"oauth":true' <<<"$FEAT"; then
  # AT: client credentials (API key, session cookie, OAuth token) never reach an upstream.
  LATENCY_CHANGED=1   # it sets ship-mcp's ECHO_REQUEST_TOOL; cleanup clears the test knobs
  suite "credential-isolation-check (client credentials never reach an upstream)" env -C services/platform/test GW_URL="$GW_URL" NS="$NS" KEY_ADMIN="$(key_for "$ADMIN_EMAIL" vdod-credentials)" \
    ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PW" SHIP_TOKEN="$(secret platform-secrets ship-mcp-token)" node credential-isolation-check.mjs
  suite "oauth-check (MCP authorization: discovery, PKCE, refresh, revocation)" env -C services/platform/test GW_URL="$GW_URL" KEY_ADMIN="$(key_for "$ADMIN_EMAIL" vdod-oauth)" node oauth-check.mjs
else
  skip "oauth-check" "platform.features.oauth is off"
fi

if [ $QUICK = 0 ]; then
  suite "gateway-check" env -C services/platform/test GW_URL="$GW_URL" KEY_ADMIN="$(key_for "$ADMIN_EMAIL" vdod-gateway)" KEY_MEMBER="$KEY_MEMBER2" \
    ADMIN_EMAIL="$ADMIN_EMAIL" MEMBER_EMAIL="$MEMBER2_EMAIL" CLI="kubectl exec -n $NS deploy/platform -c platform -- node src/cli.ts" node gateway-check.mjs
  suite "api-check" env -C services/platform/test BASE="$GW_URL" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PW" KEY_ADMIN="$(key_for "$ADMIN_EMAIL" vdod-api)" \
    SHIP_URL="http://platform-ship-mcp.$NS.svc.cluster.local:8080/mcp" SHIP_TOKEN="$(secret platform-secrets ship-mcp-token)" node api-check.mjs
  suite "woo-mcp in-cluster smoke + NetworkPolicy" tests/in-cluster-mcp.sh woo-mcp
  suite "ship-mcp in-cluster smoke + NetworkPolicy" tests/in-cluster-mcp.sh ship-mcp
else
  skip "existing suites" "--quick"
fi

if [ $ALL = 1 ]; then
  if kubectl get deploy -n "$NS" platform-provisioner >/dev/null 2>&1; then
    SHIP_IMAGE=$(kubectl get deploy -n "$NS" platform-ship-mcp -o jsonpath='{.spec.template.spec.containers[0].image}')
    suite "hosted-check (stand-out 5: a server from an image, isolated, removed cleanly)" env -C services/platform/test GW_URL="$GW_URL" NS="$NS" \
      KEY_ADMIN="$(key_for "$ADMIN_EMAIL" vdod-hosted)" KEY_MEMBER="$(key_for "$MEMBER2_EMAIL" vdod-hosted-member)" SHIP_IMAGE="$SHIP_IMAGE" node hosted-check.mjs
    # D: a malicious server, hosted like any image, against the gateway's defences. Its image is
    # built for this run only (never part of the charts); where it cannot be built, it is skipped.
    if EVIL_TAG=$(infra/scripts/build-image.sh evil-mcp 2>/dev/null | tail -1) && [ -n "$EVIL_TAG" ]; then
      suite "evil-check (a malicious MCP server meets each defence)" env -C services/platform/test GW_URL="$GW_URL" \
        KEY_ADMIN="$(key_for "$ADMIN_EMAIL" vdod-evil)" KEY_MEMBER="$(key_for "$MEMBER2_EMAIL" vdod-evil-member)" EVIL_IMAGE="urumi-evil-mcp:$EVIL_TAG" node evil-check.mjs
    else
      skip "evil-check" "could not build the evil-mcp image here (no Docker or k3d)"
    fi
    # Bonus stores: two at once, isolated, the limit, delete mid-install, a provisioner restart.
    if [ "$(kubectl get deploy -n "$NS" platform -o jsonpath='{.spec.template.spec.containers[?(@.name=="platform")].env[?(@.name=="STORES")].value}')" = on ]; then
      GW_HOSTPORT=${GW_URL#*://}; GW_HOSTPORT=${GW_HOSTPORT%%/*}; [[ $GW_HOSTPORT == *:* ]] || GW_HOSTPORT="$GW_HOSTPORT:80"
      suite "stores-check (bonus stores: in parallel, isolated, limited, removed cleanly)" env -C services/platform/test GW_URL="$GW_URL" NS="$NS" \
        KEY_ADMIN="$(key_for "$ADMIN_EMAIL" vdod-stores)" STORE_CONNECT="${GW_HOSTPORT/localhost/127.0.0.1}" \
        STORE_MAX="$(kubectl get deploy -n "$NS" platform -o jsonpath='{.spec.template.spec.containers[?(@.name=="platform")].env[?(@.name=="STORE_MAX")].value}')" node stores-check.mjs
    else
      skip "stores-check" "provisioner.stores.enabled is off"
    fi
  else
    skip "hosted-check, evil-check" "provisioner.enabled is off"
  fi
  suite "chat-check (Gemini tool loop as the user)" env -C services/platform/test BASE="$GW_URL" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PW" ORDER_ID="$ORDER_ID" ORDER_DAY="$ORDER_DAY" KEY_OTHER="$(key_for "$MEMBER2_EMAIL" vdod-chat-other)" node chat-check.mjs
  # E: the fallback provider, with every Gemini attempt forced to fail on all replicas, then restored.
  FB=$(curl -s "$GW_URL/api/chat/status" -H "authorization: Bearer $(key_for "$ADMIN_EMAIL" vdod-fallback-status)" | json 'v.fallback ?? ""')
  if [ -n "$FB" ]; then
    # After the rollout, also wait until the old pods are gone: they stay listed (and Running) while
    # they shut down, and the next suites read every listed pod's metrics.
    set_fallback() {
      kubectl set env -n "$NS" deploy/platform -c platform "CHAT_FORCE_FALLBACK$1" >/dev/null && kubectl rollout status -n "$NS" deploy/platform --timeout=180s >/dev/null || return 1
      local want; want=$(kubectl get deploy -n "$NS" platform -o jsonpath='{.spec.replicas}')
      for _ in $(seq 1 90); do [ "$(kubectl get pod -n "$NS" -l app=platform,app.kubernetes.io/instance=platform -o name | wc -l)" = "$want" ] && break; sleep 1; done
      # kube-router lets a new pod's traffic out a few seconds after it starts: wait until every new
      # gateway pod reaches the fallback provider, so the check does not race the network policy.
      local p ok
      for p in $(kubectl get pod -n "$NS" -l app=platform,app.kubernetes.io/instance=platform -o name); do
        ok=0
        for _ in $(seq 1 30); do
          kubectl exec -n "$NS" "$p" -c platform -- node -e 'fetch("https://api.groq.com/openai/v1/models",{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0),()=>process.exit(1))' >/dev/null 2>&1 && { ok=1; break; }
          sleep 1
        done
        [ $ok = 1 ] || return 1
      done
    }
    FALLBACK_FORCED=1
    if set_fallback =1; then
      suite "chat-fallback-check (Gemini forced down; $FB)" env -C services/platform/test BASE="$GW_URL" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PW" ORDER_ID="$ORDER_ID" ORDER_DAY="$ORDER_DAY" node chat-fallback-check.mjs
    else fail "chat-fallback-check" "could not set CHAT_FORCE_FALLBACK=1"; fi
    if set_fallback -; then FALLBACK_FORCED=0; else fail "restore CHAT_FORCE_FALLBACK" "run: kubectl set env -n $NS deploy/platform -c platform CHAT_FORCE_FALLBACK-"; fi
  else
    skip "chat-fallback-check" "no fallback LLM configured (make secrets FALLBACK_KEY_FILE=...)"
  fi
  suite "clients-check (MCP Inspector + Claude Code over the replicas)" env NS="$NS" GW_URL="$GW_URL" KEY="$(key_for "$ADMIN_EMAIL" vdod-clients)" tests/clients-check.sh
  LATENCY_CHANGED=1
  suite "isolation-check slow (25 s upstream vs 20 s timeout)" env -C services/platform/test GW_URL="$GW_URL" KEY_ADMIN="$(key_for "$ADMIN_EMAIL" vdod-isolation)" MODE=slow \
    BREAK_CMD="NS=$NS $ROOT/tests/ship-latency.sh 25000" FIX_CMD="NS=$NS $ROOT/tests/ship-latency.sh 0" \
    node isolation-check.mjs
else
  skip "chat-check, isolation slow" "pass --all to run them"
fi

# Last, because locally every request comes from k3d's load balancer: the bad-key flood briefly
# throttles everything from this machine (idea R).
if [ $QUICK = 0 ] || [ $ALL = 1 ]; then
  suite "auth-shield-check (bad-key flood gets 429 before lookup)" env -C services/platform/test GW_URL="$GW_URL" KEY="$KEY_ADMIN" node auth-shield-check.mjs
fi

section "summary"
echo "$PASSES passed, $FAILS failed, $SKIPS skipped"
for n in "${FAILED_NAMES[@]}"; do echo "  failed: $n"; done
[ $FAILS = 0 ] && echo "VERIFY-DOD PASSED" || echo "VERIFY-DOD FAILED"
exit $((FAILS > 0))
