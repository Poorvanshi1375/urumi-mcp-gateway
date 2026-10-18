#!/usr/bin/env bash
# Fail if a secret is about to be committed, or already is.
#
#   scripts/check-secrets.sh             staged changes (what the pre-commit hook runs)
#   scripts/check-secrets.sh --tree      every tracked file
#   scripts/check-secrets.sh --history   every commit on every branch
#   add --live to any mode               also look for the exact values of the Secrets in the
#                                        cluster (namespace $NS, default urumi); needs kubectl
#
# Two kinds of checks:
#  1. patterns of real credentials: gateway keys (urk_), WooCommerce keys (ck_/cs_), Google/Gemini,
#     AWS, GitHub, Slack, OpenAI and Anthropic keys, private key blocks, kubeconfig client data;
#  2. --live: the actual values stored in the cluster's Secrets. This is the check that catches a
#     password copied into a values file, which no pattern can recognise.
# Matches are reported by file and line with the value masked; secrets are never printed.
# A line can be allowed with the marker  check-secrets:allow  (only for test fixtures).
set -euo pipefail
cd "$(dirname "$0")/.."
NS=${NS:-urumi}
MODE=staged; LIVE=0
for a in "$@"; do case $a in --tree) MODE=tree;; --history) MODE=history;; --live) LIVE=1;; *) echo "unknown option $a" >&2; exit 2;; esac; done

PATTERNS=(
  'urk_[A-Za-z0-9_-]{43}'                       # our gateway API keys
  'c[ks]_[a-z0-9]{40}'                          # WooCommerce REST consumer key / secret
  'AIza[0-9A-Za-z_-]{35}'                       # Google / Gemini API key
  'AKIA[0-9A-Z]{16}'                            # AWS access key id
  'gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}'
  'xox[abpr]-[A-Za-z0-9-]{10,}'                 # Slack
  'sk-(proj-|ant-)?[A-Za-z0-9_-]{32,}'          # OpenAI / Anthropic
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
  'client-(key|certificate)-data: *[A-Za-z0-9+/=]{40,}'
)
RE=$(IFS='|'; echo "${PATTERNS[*]}")

# The text to scan, as "location<TAB>line" records.
content() {
  case $MODE in
    staged)  git diff --cached --no-color -U0 --diff-filter=ACMR | awk '/^\+\+\+ b\//{f=substr($0,7)} /^\+[^+]/{n++; print f"\t"substr($0,2)}' ;;
    tree)    git ls-files -z | xargs -0 grep -nIH '' -- 2>/dev/null | sed -E 's/^([^:]*:[0-9]+):/\1\t/' ;;
    history) git log --all -p --no-color --format='commit %h' | awk '/^commit /{c=$2} /^\+\+\+ b\//{f=substr($0,7)} /^\+[^+]/{print c":"f"\t"substr($0,2)}' ;;
  esac
}

TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
content | grep -v 'check-secrets:allow' > "$TMP/scan" || true
found=0
mask() { sed -E 's/([A-Za-z0-9_+/=-]{4})[A-Za-z0-9_+/=-]{8,}/\1********/g'; }

if grep -En -- "$RE" "$TMP/scan" | cut -d: -f2- > "$TMP/hits"; then
  found=1; echo "Secret-like values found ($MODE):"
  cut -f1 "$TMP/hits" | sort -u | sed 's/^/  /'
  grep -Eo -- "$RE" "$TMP/hits" | mask | sort -u | sed 's/^/    looks like: /'
fi

if [ $LIVE = 1 ]; then
  # Every value of every Opaque Secret in the namespace, decoded, at least 8 characters long.
  kubectl get secrets -n "$NS" -o json | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      for (const i of JSON.parse(s).items) { if (i.type!=="Opaque") continue;
        for (const [k,v] of Object.entries(i.data??{})) { const t=Buffer.from(v,"base64").toString("utf8").trim(); if (t.length>=8 && !/\n/.test(t)) console.log(i.metadata.name+"/"+k+"\t"+t); } } });' > "$TMP/live"
  cut -f2 "$TMP/live" > "$TMP/values"
  echo "live check: $(wc -l < "$TMP/values") secret values from namespace $NS"
  if [ -s "$TMP/values" ] && grep -nF -f "$TMP/values" "$TMP/scan" > "$TMP/livehits"; then
    found=1; echo "Values of cluster Secrets found ($MODE):"
    while IFS= read -r line; do
      loc=$(cut -d: -f2- <<<"$line" | cut -f1)
      while IFS=$'\t' read -r name val; do grep -qF -- "$val" <<<"$line" && echo "  $loc contains the value of Secret $name"; done < "$TMP/live"
    done < "$TMP/livehits" | sort -u
  fi
fi

if [ $found = 1 ]; then
  echo "check-secrets: FAILED. Remove the value and load it from a Kubernetes Secret instead."
  exit 1
fi
echo "check-secrets: OK ($MODE$([ $LIVE = 1 ] && echo ', live values'), $(wc -l < "$TMP/scan") lines scanned)"
