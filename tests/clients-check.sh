#!/usr/bin/env bash
# Real MCP clients against the gateway with 2+ replicas (work item 12): MCP Inspector's CLI and
# Claude Code, each with only the gateway URL and an API key. Afterwards, each gateway pod's
# /metrics shows how many of these calls it served, which proves both replicas handled them.
# Usage: GW_URL=... KEY=<api key> tests/clients-check.sh      (NS, default urumi)
set -uo pipefail
NS=${NS:-urumi}; GW_URL=${GW_URL:?}; KEY=${KEY:?}
INSPECTOR="@modelcontextprotocol/inspector@2.8.0"
export NODE_OPTIONS="${NODE_OPTIONS:-} --network-family-autoselection-attempt-timeout=2000"
fails=0
pods=$(kubectl get pod -n "$NS" -l app=platform,app.kubernetes.io/instance=platform --field-selector=status.phase=Running -o jsonpath='{.items[*].metadata.name}')
calls() { kubectl exec -n "$NS" "$1" -c platform -- wget -qO- http://127.0.0.1:9464/metrics | awk '/^mcp_tool_calls_total/ {n += $NF} END {print n+0}'; }
declare -A before; for p in $pods; do before[$p]=$(calls "$p"); done
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; cd "$TMP"
# Precondition: every enabled server listed on every replica (a server re-enabled by an earlier test
# reaches each replica within about a second).
want=$(curl -s -H "authorization: Bearer $KEY" "$GW_URL/api/servers" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).servers.filter(x=>x.enabled).reduce((n,x)=>n+x.tools.filter(t=>!t.pending).length,0)))')
for i in $(seq 1 30); do
  ok=1; for j in 1 2 3 4; do
    n=$(curl -s -X POST "$GW_URL/mcp" -H "authorization: Bearer $KEY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | sed -n 's/^data: //p;t;/^{/p' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result.tools.length)}catch{console.log(0)}})')
    [ "$n" = "$want" ] || ok=0
  done
  [ $ok = 1 ] && break; sleep 1
done
echo "precondition: $want tools listed consistently"

echo "--- MCP Inspector $INSPECTOR (CLI)"
n=$(npx -y "$INSPECTOR" --cli "$GW_URL/mcp" --transport http --header "Authorization: Bearer $KEY" --method tools/list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tools.length)}catch{console.log("ERR "+s.slice(0,200))}})')
[[ $n =~ ^[0-9]+$ && $n -gt 0 ]] && echo "PASS  inspector tools/list: $n tools" || { echo "FAIL  inspector tools/list: $n"; fails=$((fails+1)); }
ok=0
for i in 1 2 3 4 5 6; do
  out=$(npx -y "$INSPECTOR" --cli "$GW_URL/mcp" --transport http --header "Authorization: Bearer $KEY" --method tools/call --tool-name woo__list_orders --tool-arg per_page=1 2>/dev/null)
  r=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(!j.isError&&/"count"/.test(j.content[0].text)?"ok":"err "+s.slice(0,120))}catch{console.log("unparsable "+s.slice(0,120))}})' <<<"$out")
  if [ "$r" = ok ]; then ok=$((ok+1)); else last="$r"; fi
done
[ $ok = 6 ] && echo "PASS  inspector tools/call woo__list_orders x6: all ok" || { echo "FAIL  inspector tools/call: $ok/6 ok (${last:-})"; fails=$((fails+1)); }

echo "--- Claude Code $(claude --version 2>/dev/null | head -1)"
printf '{"mcpServers":{"urumi":{"type":"http","url":"%s/mcp","headers":{"Authorization":"Bearer %s"}}}}' "$GW_URL" "$KEY" > mcp.json
# The prompt goes right after -p: --allowedTools takes several values and would swallow it.
answer=$(timeout 300 claude -p "Call woo__list_orders with per_page 3. For each order, call ship__get_order. Then answer in one line per order: id, total, carrier, tracking number." \
  --strict-mcp-config --mcp-config mcp.json \
  --allowedTools "mcp__urumi__woo__list_orders,mcp__urumi__ship__get_order,mcp__urumi__ship__track_shipment" < /dev/null 2>&1)
rm -f mcp.json
echo "$answer" | tail -6
grep -qE "URS0000[0-9]+" <<<"$answer" && echo "PASS  claude code: orders with tracking numbers through the gateway" || { echo "FAIL  claude code answer has no tracking numbers"; fails=$((fails+1)); }

echo "--- calls served per gateway replica (from each pod's /metrics)"
served=0
for p in $pods; do d=$(( $(calls "$p") - ${before[$p]} )); echo "  $p: +$d tool calls"; [ "$d" -gt 0 ] && served=$((served+1)); done
[ "$served" -ge 2 ] && echo "PASS  both replicas served these clients' calls" || { echo "FAIL  only $served replica(s) served calls"; fails=$((fails+1)); }
[ $fails = 0 ] && echo "CLIENTS CHECK PASSED" || echo "CLIENTS CHECK FAILED ($fails)"
exit $((fails > 0))
