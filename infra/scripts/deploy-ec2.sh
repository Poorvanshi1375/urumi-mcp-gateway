#!/usr/bin/env bash
# Deploy both charts to a single EC2 instance running k3s (Gate 4). Same charts as k3d; only values
# differ (values-prod.yaml + the host names below). Idempotent: safe to re-run after changes.
#
# Usage: infra/scripts/deploy-ec2.sh <public-ip> <path-to-key.pem>
# Needs locally: docker (with the images built by infra/scripts/build-image.sh), helm, kubectl access
# to the local k3d cluster (to read the image tags and the Gemini key secret), ssh, scp.
# Secrets: scripts/secrets.sh runs on the node (charts only reference them via existingSecret).
set -euo pipefail
IP="${1:?usage: deploy-ec2.sh <public-ip> <key.pem>}"; KEY="${2:?usage: deploy-ec2.sh <public-ip> <key.pem>}"
cd "$(dirname "$0")/../.."
K3S_VERSION="v1.35.5+k3s1"            # same as the local k3d cluster
CERT_MANAGER_VERSION="v1.21.2"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"   # optional: Let's Encrypt expiry notices
NS=urumi
STORE_HOST="store.${IP}.nip.io"; APP_HOST="app.${IP}.nip.io"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 "ubuntu@${IP}")
step() { printf '\n==> %s\n' "$*"; }

# Images: deploy exactly what runs locally (tags from the local platform release).
TAGS=$(helm get values platform -n "$NS" -o json | python3 -c 'import json,sys; v=json.load(sys.stdin); print(v["image"]["tag"], v["wooMcp"]["image"]["tag"], v["shipMcp"]["image"]["tag"])')
read -r PT WT ST <<<"$TAGS"
IMAGES=("urumi-platform:$PT" "urumi-woo-mcp:$WT" "urumi-ship-mcp:$ST")

step "k3s $K3S_VERSION on $IP"
"${SSH[@]}" "command -v k3s >/dev/null && sudo k3s --version | head -1 || (curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION='$K3S_VERSION' sh -s - --write-kubeconfig-mode 644)"
"${SSH[@]}" 'for i in $(seq 1 60); do sudo k3s kubectl get nodes 2>/dev/null | grep -q " Ready" && break; sleep 3; done; sudo k3s kubectl get nodes -o wide'

step "helm (copied from this machine: $(helm version --short))"
"${SSH[@]}" 'command -v helm >/dev/null' || { scp -i "$KEY" "$(command -v helm)" "ubuntu@${IP}:/tmp/helm" && "${SSH[@]}" 'sudo install -m 755 /tmp/helm /usr/local/bin/helm && rm /tmp/helm'; }

step "images: ${IMAGES[*]}"
for img in "${IMAGES[@]}"; do
  if "${SSH[@]}" "sudo k3s ctr -n k8s.io images ls -q | grep -qx 'docker.io/library/$img'"; then echo "  $img already on the node"; continue; fi
  echo "  copying $img"; docker save --platform linux/amd64 "$img" | "${SSH[@]}" 'sudo k3s ctr -n k8s.io images import - >/dev/null'
done

step "charts (as committed: $(git log -1 --format=%h -- infra/helm))"
# Deploy what is in git, never the working tree: editing a chart while a deploy runs must not
# leak half-done changes to the server.
git diff --quiet HEAD -- infra/helm || echo "  note: uncommitted chart changes are NOT deployed"
git archive HEAD infra/helm/urumi-store infra/helm/urumi-platform | "${SSH[@]}" 'rm -rf ~/urumi-helm && mkdir -p ~/urumi-helm && tar -xf - --strip-components=2 -C ~/urumi-helm'

step "secrets (scripts/secrets.sh on the node; values never leave a temp file)"
scp -q -i "$KEY" scripts/secrets.sh "ubuntu@${IP}:urumi-helm/secrets.sh"
GEM=""
if kubectl get secret -n "$NS" platform-llm >/dev/null 2>&1; then
  # The local Gemini key goes over SSH to a mode-600 file that is removed right after use.
  kubectl get secret -n "$NS" platform-llm -o jsonpath='{.data.gemini-api-key}' | base64 -d | "${SSH[@]}" 'umask 077; cat > ~/urumi-helm/gemini.key'
  GEM="--gemini-key-file ~/urumi-helm/gemini.key"
else echo "  no local platform-llm secret: chat will report 'not configured'"; fi
"${SSH[@]}" "cd ~/urumi-helm && NS=$NS KUBECTL='sudo k3s kubectl' bash secrets.sh $GEM; rm -f ~/urumi-helm/gemini.key"

step "cert-manager $CERT_MANAGER_VERSION and the Let's Encrypt issuer (HTTP-01 through Traefik)"
"${SSH[@]}" "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
  helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1; helm repo update jetstack >/dev/null && \
  helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --version $CERT_MANAGER_VERSION \
    --set crds.enabled=true --wait --timeout 5m | grep -E 'STATUS|REVISION'"
"${SSH[@]}" "sudo k3s kubectl apply -f - >/dev/null && echo '  ClusterIssuer letsencrypt applied'" <<ISSUER
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    ${LETSENCRYPT_EMAIL:+email: $LETSENCRYPT_EMAIL}
    privateKeySecretRef: { name: letsencrypt-account-key }
    solvers:
      - http01:
          ingress: { ingressClassName: traefik }
ISSUER

step "store chart (store.host=$STORE_HOST)"
"${SSH[@]}" "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; cd ~/urumi-helm && \
  helm lint urumi-store -f urumi-store/values-prod.yaml --set store.host=$STORE_HOST --set store.homeUrl=https://$STORE_HOST | tail -1 && \
  helm upgrade --install store urumi-store -n $NS -f urumi-store/values-prod.yaml \
    --set store.host=$STORE_HOST --set store.homeUrl=https://$STORE_HOST --wait --timeout 15m | grep -E 'STATUS|REVISION'"

step "platform chart (app host=$APP_HOST)"
# The store's home URL is https, but woo-mcp calls WordPress over plain HTTP inside the cluster, so
# WooCommerce verifies the OAuth signature over the http form of the URL (KT D.4).
PSET="--set platform.ingress.host=$APP_HOST --set wooMcp.store.signingBaseUrl=http://$STORE_HOST --set image.tag=$PT --set wooMcp.image.tag=$WT --set shipMcp.image.tag=$ST"
"${SSH[@]}" "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; cd ~/urumi-helm && \
  helm lint urumi-platform -f urumi-platform/values-prod.yaml $PSET | tail -1 && \
  helm upgrade --install platform urumi-platform -n $NS -f urumi-platform/values-prod.yaml $PSET --wait --timeout 10m | grep -E 'STATUS|REVISION'"

step "status"
"${SSH[@]}" "sudo k3s kubectl get pods -n $NS -o wide"
cat <<EOF

Store:     https://$STORE_HOST/shop/
Dashboard: https://$APP_HOST/        (MCP endpoint: https://$APP_HOST/mcp)
Admin password:
  ssh -i $KEY ubuntu@$IP "sudo k3s kubectl get secret -n $NS platform-secrets -o jsonpath='{.data.admin-password}' | base64 -d"; echo
EOF
