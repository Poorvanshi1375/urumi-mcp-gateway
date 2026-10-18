#!/usr/bin/env bash
# Automated definition-of-done checks against the running cluster (namespace urumi).
#
#   scripts/verify-dod.sh            store, Kubernetes, network isolation, the DoD flow, and the
#                                    existing suites (gateway-check, api-check, in-cluster MCP smoke)
#   scripts/verify-dod.sh --quick    skip the existing suites
#   scripts/verify-dod.sh --all      also chat-check (uses the Gemini quota) and the slow-upstream test
#   scripts/verify-dod.sh --keep     keep the temporary users and their audit rows for inspection
# Another cluster (e.g. the VPS through an SSH tunnel): set KUBECONFIG, GW_URL and STORE_URL.
#
# It never touches the demo users or demo data: it creates temporary users vdod-*@example.com with
# their own keys, and on exit removes them, their audit and activity rows, rows from unauthenticated test
# requests made during the run, users created by api-check, and TEST draft products.
# Steps that cannot be automated are listed in docs/DEMO_SCRIPT.md.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
NS=${NS:-urumi}
GW_URL=${GW_URL:-http://localhost:9080}
STORE_URL=${STORE_URL:-http://store.localhost:9080}
# Node gives each address only 250 ms to connect; a far-away gateway (India -> Sydney ~300 ms) then
# fails with ETIMEDOUT although curl works. Same setting as the platform image.
export NODE_OPTIONS="${NODE_OPTIONS:-} --network-family-autoselection-attempt-timeout=2000"
QUICK=0; ALL=0; KEEP=0
for a in "$@"; do case $a in --quick) QUICK=1;; --all) ALL=1;; --keep) KEEP=1;; *) echo "unknown option $a"; exit 2;; esac; done

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

cleanup() {
  section "cleanup"
  "${CLI[@]}" upstreams enable ship >/dev/null 2>&1 && echo "ship enabled"
  [ "$(kubectl get deploy -n "$NS" platform-ship-mcp -o jsonpath='{.spec.replicas}' 2>/dev/null)" = 0 ] && kubectl scale -n "$NS" deploy/platform-ship-mcp --replicas=1 >/dev/null && echo "ship-mcp scaled back to 1"
  if [ $LATENCY_CHANGED = 1 ]; then NS=$NS tests/ship-latency.sh 0; kubectl set env -n "$NS" deploy/platform-ship-mcp TOOL_DESCRIPTION_SUFFIX="" >/dev/null 2>&1; fi
  kubectl delete pod -n "$NS" -l vdod=probe --ignore-not-found --wait=false >/dev/null 2>&1
  if [ $KEEP = 1 ]; then echo "--keep: temporary users $ADMIN_EMAIL, $MEMBER_EMAIL, $MEMBER2_EMAIL kept"; else
    psql_exec "begin;
      delete from audit_events where user_id in (select id from users where email like 'vdod-%@example.com' or email like 'invitee-%@example.com');
      delete from audit_events where user_id is null and created_at >= '$START_SQL';
      delete from activity_events where actor_email like 'vdod-%@example.com' or actor_email like 'invitee-%@example.com'
        or target like 'vdod-%@example.com' or target like 'invitee-%@example.com' or target = 'shipcopy'
        or (created_at >= '$START_SQL' and (actor_id is null or actor_email = 'cli'));
      delete from invites where email like 'invitee-%@example.com' or email = 'x@example.com';
      delete from users where email like 'vdod-%@example.com' or email like 'invitee-%@example.com';
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

section "preflight"
kubectl get deploy -n "$NS" platform >/dev/null 2>&1 || { echo "no platform deployment in namespace $NS (is the cluster up?)"; exit 1; }
[ -d services/platform/node_modules ] || { echo "run: (cd services/platform && npm ci)"; exit 1; }
echo "context $(kubectl config current-context), namespace $NS, gateway $GW_URL, store $STORE_URL"

suite "unit-check (names, caps, delimiter, routing; no cluster)" env -C services/platform node test/unit-check.mjs

# ---------------------------------------------------------------------------------------------
section "store (D1 prerequisites)"
code=$(curl -s -o "$TMP/shop.html" -w '%{http_code}' "$STORE_URL/shop/")
if [ "$code" = 200 ] && grep -q 'woocommerce' "$TMP/shop.html"; then pass "storefront /shop/ responds" "HTTP 200, WooCommerce page"; else fail "storefront /shop/ responds" "HTTP $code"; fi
n=$(curl -s "$STORE_URL/wp-json/wc/store/v1/products" | json 'v.length' 2>/dev/null)
if [ "${n:-0}" -ge 1 ] 2>/dev/null; then pass "WooCommerce REST (Store API) responds" "$n published products"; else fail "WooCommerce REST (Store API) responds" "got: ${n:-nothing}"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' "$STORE_URL/wp-login.php")
[ "$code" = 200 ] && pass "wp-admin login page" "HTTP 200" || fail "wp-admin login page" "HTTP $code"

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
# Every container: non-root, no privilege escalation, all capabilities dropped, seccomp RuntimeDefault.
sec=$(kubectl get pods -n "$NS" -o json | node scripts/lib/pod-security.mjs)
[[ $sec == OK* ]] && pass "non-root, no escalation, caps dropped, seccomp (all containers)" "${sec#OK }" || fail "non-root, no escalation, caps dropped, seccomp (all containers)" "${sec#BAD }"
routes=$(kubectl get ingress -A -o json | json "v.items.flatMap(i=>i.spec.rules.flatMap(r=>r.http.paths.map(p=>(r.host||'*')+'->'+p.backend.service.name))).join(' ')")
if grep -qE 'mcp|postgres|mysql' <<<"$routes"; then fail "Ingress exposes only the store and the platform" "$routes"; else pass "Ingress exposes only the store and the platform" "$routes"; fi

# ---------------------------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------------------------
section "temporary users and keys"
key_for() { "${CLI[@]}" keys create "$1" "$2" | json 'v.key'; }
"${CLI[@]}" users add "$ADMIN_EMAIL" admin "$ADMIN_PW" >/dev/null && "${CLI[@]}" users add "$MEMBER_EMAIL" member >/dev/null && "${CLI[@]}" users add "$MEMBER2_EMAIL" member >/dev/null \
  || { fail "create temporary users"; exit 1; }
KEY_ADMIN=$(key_for "$ADMIN_EMAIL" vdod); KEY_MEMBER=$(key_for "$MEMBER_EMAIL" vdod); KEY_MEMBER2=$(key_for "$MEMBER2_EMAIL" vdod)
[[ $KEY_ADMIN == urk_* && $KEY_MEMBER == urk_* && $KEY_MEMBER2 == urk_* ]] && echo "created $ADMIN_EMAIL (admin), $MEMBER_EMAIL and $MEMBER2_EMAIL (members), one key each" || { fail "create temporary keys"; exit 1; }

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
  suite "scaling-check ($REPLICAS gateway replicas)" env -C services/platform/test GW_URL="$GW_URL" NS="$NS" KEY_ADMIN="$KEY_ADMIN" KEY_MEMBER="$KEY_MEMBER4" node scaling-check.mjs
else
  skip "scaling-check" "the gateway runs ${REPLICAS:-1} replica"
fi

FEAT=$(curl -s -H "authorization: Bearer $KEY_ADMIN" "$GW_URL/api/features")
if grep -q true <<<"$FEAT"; then
  # A fresh member key: dod-check revoked the first one.
  KEY_MEMBER3=$(key_for "$MEMBER2_EMAIL" vdod-features)
  suite "features-check ($FEAT)" env -C services/platform/test GW_URL="$GW_URL" NS="$NS" KEY_ADMIN="$KEY_ADMIN" KEY_MEMBER="$KEY_MEMBER3" MEMBER_EMAIL="$MEMBER2_EMAIL" node features-check.mjs
  LATENCY_CHANGED=1   # it changes ship-mcp's env; cleanup puts the test knobs back
else
  skip "features-check" "tool pinning and search mode are off"
fi

if [ $QUICK = 0 ]; then
  suite "gateway-check" env -C services/platform/test GW_URL="$GW_URL" KEY_ADMIN="$KEY_ADMIN" KEY_MEMBER="$KEY_MEMBER2" \
    ADMIN_EMAIL="$ADMIN_EMAIL" MEMBER_EMAIL="$MEMBER2_EMAIL" CLI="kubectl exec -n $NS deploy/platform -c platform -- node src/cli.ts" node gateway-check.mjs
  suite "api-check" env -C services/platform/test BASE="$GW_URL" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PW" KEY_ADMIN="$KEY_ADMIN" \
    SHIP_URL="http://platform-ship-mcp.$NS.svc.cluster.local:8080/mcp" SHIP_TOKEN="$(secret platform-secrets ship-mcp-token)" node api-check.mjs
  suite "woo-mcp in-cluster smoke + NetworkPolicy" tests/in-cluster-mcp.sh woo-mcp
  suite "ship-mcp in-cluster smoke + NetworkPolicy" tests/in-cluster-mcp.sh ship-mcp
else
  skip "existing suites" "--quick"
fi

if [ $ALL = 1 ]; then
  suite "chat-check (Gemini tool loop as the user)" env -C services/platform/test BASE="$GW_URL" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PW" ORDER_ID="$ORDER_ID" ORDER_DAY="$ORDER_DAY" node chat-check.mjs
  suite "clients-check (MCP Inspector + Claude Code over the replicas)" env NS="$NS" GW_URL="$GW_URL" KEY="$(key_for "$ADMIN_EMAIL" vdod-clients)" tests/clients-check.sh
  LATENCY_CHANGED=1
  suite "isolation-check slow (25 s upstream vs 20 s timeout)" env -C services/platform/test GW_URL="$GW_URL" KEY_ADMIN="$KEY_ADMIN" MODE=slow \
    BREAK_CMD="NS=$NS $ROOT/tests/ship-latency.sh 25000" FIX_CMD="NS=$NS $ROOT/tests/ship-latency.sh 0" \
    node isolation-check.mjs
else
  skip "chat-check, isolation slow" "pass --all to run them"
fi

section "summary"
echo "$PASSES passed, $FAILS failed, $SKIPS skipped"
for n in "${FAILED_NAMES[@]}"; do echo "  failed: $n"; done
[ $FAILS = 0 ] && echo "VERIFY-DOD PASSED" || echo "VERIFY-DOD FAILED"
exit $((FAILS > 0))
