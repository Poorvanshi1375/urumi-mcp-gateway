#!/usr/bin/env bash
# Create the Kubernetes Secrets both charts reference (secrets.existingSecret). Nothing secret is
# ever in git, Helm values or Helm's release history: the charts only name these Secrets.
#
#   scripts/secrets.sh [--gemini-key-file <file>]
#
# Idempotent. An existing Secret is never changed: existing keys keep their values (they must keep
# matching the data on the volumes, e.g. the MySQL and Postgres passwords and the key that encrypts
# upstream credentials); only missing keys are added. Values are generated with openssl and passed
# to kubectl through files in a private temp directory, never on a command line.
#
#   store-secrets     mysql-root-password, mysql-password, wp-admin-password,
#                     woo-consumer-key, woo-consumer-secret          (urumi-store chart)
#   platform-secrets  postgres-password, encryption-key, admin-password,
#                     woo-mcp-token, ship-mcp-token                  (urumi-platform chart)
#   platform-llm      gemini-api-key, from --gemini-key-file or $GEMINI_API_KEY_FILE (optional:
#                     without it the chat page says chat is not configured)
#
# Env: NS (default urumi), KUBECTL (default kubectl; on a k3s node "sudo k3s kubectl").
# Needs only bash, openssl, base64 and kubectl, so it also runs on a bare k3s node.
set -euo pipefail
NS=${NS:-urumi}
read -r -a K <<<"${KUBECTL:-kubectl}"
GEMINI_FILE=${GEMINI_API_KEY_FILE:-}
while [ $# -gt 0 ]; do case $1 in --gemini-key-file) GEMINI_FILE=${2:?file}; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done

TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
rand() { openssl rand -base64 96 | tr -dc "${2:-A-Za-z0-9}" | head -c "$1"; }

"${K[@]}" get namespace "$NS" >/dev/null 2>&1 || { "${K[@]}" create namespace "$NS" >/dev/null; echo "namespace $NS created"; }

# ensure <secret> <key>=<generator> ...   generator: "rand N [charset]" or "prefix:<p> N"
ensure() {
  local name=$1; shift
  local existing=0 have=()
  if "${K[@]}" get secret -n "$NS" "$name" >/dev/null 2>&1; then
    existing=1
    mapfile -t have < <("${K[@]}" get secret -n "$NS" "$name" -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}')
  fi
  local missing=() spec key gen
  for spec in "$@"; do
    key=${spec%%=*}; gen=${spec#*=}
    [[ " ${have[*]} " == *" $key "* ]] && continue
    case $gen in
      prefix:*) local p=${gen#prefix:}; p=${p%% *}; printf '%s%s' "$p" "$(rand "${gen##* }" 'a-z0-9')" > "$TMP/$key" ;;
      file:*)   tr -d '\r\n' < "${gen#file:}" > "$TMP/$key" ;;
      *)        rand "$gen" > "$TMP/$key" ;;
    esac
    missing+=("$key")
  done
  if [ $existing = 0 ]; then
    local args=(); for key in "${missing[@]}"; do args+=(--from-file="$key=$TMP/$key"); done
    "${K[@]}" create secret generic "$name" -n "$NS" "${args[@]}" >/dev/null
    "${K[@]}" label secret "$name" -n "$NS" app.kubernetes.io/managed-by=secrets.sh >/dev/null
    echo "$name: created (${missing[*]})"
  elif [ ${#missing[@]} -gt 0 ]; then
    # base64 values and our key names need no JSON escaping
    local parts=(); for key in "${missing[@]}"; do parts+=("\"$key\":\"$(base64 -w0 < "$TMP/$key")\""); done
    (IFS=,; printf '{"data":{%s}}' "${parts[*]}") > "$TMP/patch.json"
    "${K[@]}" patch secret "$name" -n "$NS" --type merge --patch-file "$TMP/patch.json" >/dev/null
    echo "$name: kept existing keys, added ${missing[*]}"
  else
    echo "$name: exists, all keys present, unchanged"
  fi
}

# A Secret recreated next to old volumes would hold new passwords that no longer open the old data.
for pair in "store-secrets:data-store-mysql-0" "platform-secrets:data-platform-postgres-0"; do
  s=${pair%%:*}; pvc=${pair#*:}
  if ! "${K[@]}" get secret -n "$NS" "$s" >/dev/null 2>&1 && "${K[@]}" get pvc -n "$NS" "$pvc" >/dev/null 2>&1; then
    echo "refusing: Secret $s is missing but volume $pvc still exists; its database was initialised with the old password." >&2
    echo "Restore the old Secret, or delete the volume for a clean start: kubectl delete pvc -n $NS $pvc" >&2
    exit 1
  fi
done

ensure store-secrets \
  mysql-root-password=32 mysql-password=32 wp-admin-password=24 \
  "woo-consumer-key=prefix:ck_ 40" "woo-consumer-secret=prefix:cs_ 40"
ensure platform-secrets \
  postgres-password=32 encryption-key=48 admin-password=20 woo-mcp-token=48 ship-mcp-token=48

if [ -n "$GEMINI_FILE" ]; then
  [ -s "$GEMINI_FILE" ] || { echo "Gemini key file $GEMINI_FILE is empty or missing" >&2; exit 1; }
  ensure platform-llm "gemini-api-key=file:$GEMINI_FILE"
elif "${K[@]}" get secret -n "$NS" platform-llm >/dev/null 2>&1; then
  echo "platform-llm: exists, unchanged"
else
  echo "platform-llm: not created (no --gemini-key-file); the chat agent will report 'not configured'"
fi
