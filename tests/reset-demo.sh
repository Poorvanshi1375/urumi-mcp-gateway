#!/usr/bin/env bash
# Reset the platform to clean demo data (k3d, namespace urumi). Run after test suites, before recording.
#  - deletes ALL audit and activity rows, invites, sessions, API keys, and every user except admin@example.com
#  - keeps the registered servers and the store (products, orders) untouched
#  - re-creates User A (admin) and User B (member) through the real invite flow. Their names and
#    emails come from A_NAME, A_EMAIL, B_NAME, B_EMAIL, or from ~/.urumi-demo-users (a private file
#    with those variables, never committed), or default to neutral placeholders.
# Writes the demo passwords to ~/urumi-demo-credentials.txt (mode 600), or ~/urumi-demo-credentials-<host>.txt
# for another cluster. Usage: tests/reset-demo.sh [--yes]
# Another cluster (e.g. the VPS): KUBECONFIG=~/.kube/urumi-vps.yaml BASE=http://app.<ip>.nip.io tests/reset-demo.sh
set -euo pipefail
NS=urumi; BASE=${BASE:-http://localhost:9080}
HOST=${BASE#*://}; HOST=${HOST%%[:/]*}
CRED=~/urumi-demo-credentials.txt; [ "$HOST" = localhost ] || CRED=~/urumi-demo-credentials-$HOST.txt
# Node gives each address 250 ms to connect by default; too short for a far-away VPS.
export NODE_OPTIONS="${NODE_OPTIONS:-} --network-family-autoselection-attempt-timeout=2000"
DEMO_USERS_FILE=${DEMO_USERS_FILE:-$HOME/.urumi-demo-users}
[ -r "$DEMO_USERS_FILE" ] && . "$DEMO_USERS_FILE"
A_NAME=${A_NAME:-User A}; A_EMAIL=${A_EMAIL:-user-a@example.com}
B_NAME=${B_NAME:-User B}; B_EMAIL=${B_EMAIL:-user-b@example.com}
# The dashboard lowercases emails; sign in with these.
A_EMAIL=$(tr '[:upper:]' '[:lower:]' <<<"$A_EMAIL"); B_EMAIL=$(tr '[:upper:]' '[:lower:]' <<<"$B_EMAIL")
if [ "${1:-}" != "--yes" ]; then
  echo "This deletes all audit rows, invites, sessions, API keys and non-bootstrap users in namespace $NS."
  read -r -p "Type 'reset' to continue: " ans; [ "$ans" = reset ] || { echo "aborted"; exit 1; }
fi
kubectl exec -n $NS platform-postgres-0 -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -c "
begin;
delete from audit_events; delete from activity_events; delete from invites; delete from sessions; delete from api_keys;
delete from users where email <> '"'"'admin@example.com'"'"';
update users set name = '"'"'Platform Admin'"'"' where email = '"'"'admin@example.com'"'"';
commit;"'
umask 077
ADMIN_PW=$(kubectl get secret -n $NS platform-secrets -o jsonpath='{.data.admin-password}' | base64 -d)
PA="demo-a-$(openssl rand -hex 6)"; PB="demo-b-$(openssl rand -hex 6)"
BASE=$BASE ADMIN_PW="$ADMIN_PW" PA="$PA" PB="$PB" A="$A_EMAIL|$A_NAME" B="$B_EMAIL|$B_NAME" node --input-type=module -e "
const B = process.env.BASE;
const session = () => { let cookie = ''; return async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
  for (const c of r.headers.getSetCookie()) cookie = c.split(';')[0];
  const j = await r.json(); if (!r.ok) throw new Error(p + ' ' + r.status + ' ' + JSON.stringify(j)); return j; }; };
const admin = session();
await admin('POST', '/api/auth/login', { email: 'admin@example.com', password: process.env.ADMIN_PW });
for (const [spec, role, pw] of [[process.env.A, 'admin', process.env.PA], [process.env.B, 'member', process.env.PB]]) {
  const [email, name] = spec.split('|');
  const inv = await admin('POST', '/api/invites', { email, role });
  const u = session(); await u('POST', '/api/invites/accept', { token: inv.token, name, password: pw });
  console.log('created via invite:', name, email, role);
}"
printf 'Urumi Gateway demo accounts (%s)\nUser A (admin):  %s  %s  %s\nUser B (member): %s  %s  %s\nPlatform admin:  admin@example.com  (password: kubectl get secret -n urumi platform-secrets -o jsonpath={.data.admin-password} | base64 -d)\n' "$BASE" "$A_NAME" "$A_EMAIL" "$PA" "$B_NAME" "$B_EMAIL" "$PB" > $CRED
echo "credentials: $CRED"
