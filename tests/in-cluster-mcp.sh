#!/usr/bin/env bash
# In-cluster checks for one of our MCP upstreams (namespace urumi, release platform):
#  1. a pod labelled like the gateway (app=platform) runs smoke.mjs against the Service -> must pass;
#  2. an unlabelled pod tries to connect -> must be blocked by the NetworkPolicy (W4);
#  3. no Ingress routes to woo-mcp.
set -euo pipefail
SVC_NAME="${1:?usage: in-cluster-mcp.sh <woo-mcp|ship-mcp>}"
cd "$(dirname "$0")/../services/$SVC_NAME/test"
NS=urumi; SVC=http://platform-$SVC_NAME.urumi.svc.cluster.local:8080
kubectl delete pod -n $NS $SVC_NAME-allowed $SVC_NAME-denied --ignore-not-found --wait=true >/dev/null
kubectl create configmap $SVC_NAME-tests -n $NS --from-file=package.json --from-file=package-lock.json --from-file=smoke.mjs \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
pod() { # name, extra labels (json), command
cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $1
  namespace: $NS
  labels: $2
spec:
  restartPolicy: Never
  # Restricted Pod Security, like the namespace enforces: the image's node user, no privileges.
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: t
      image: node:24-alpine
      imagePullPolicy: IfNotPresent
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      workingDir: /work
      command: ["sh", "-c", "cp /src/* /work/ && $3"]
      env:
        - { name: HOME, value: /tmp }
        - { name: MCP_URL, value: "$SVC/mcp" }
        - name: MCP_BEARER_TOKEN
          valueFrom: { secretKeyRef: { name: platform-secrets, key: $SVC_NAME-token } }
      resources: { requests: { cpu: 50m, memory: 96Mi }, limits: { cpu: "1", memory: 384Mi } }
      volumeMounts: [ { name: src, mountPath: /src }, { name: work, mountPath: /work } ]
  volumes:
    - { name: src, configMap: { name: $SVC_NAME-tests } }
    - { name: work, emptyDir: {} }
YAML
}
pod $SVC_NAME-allowed '{"app": "platform", "app.kubernetes.io/instance": "platform"}' \
  "npm ci --no-audit --no-fund --loglevel=error >/dev/null && node smoke.mjs"
pod $SVC_NAME-denied '{"app": "intruder"}' \
  "node -e \\\"fetch('$SVC/healthz',{signal:AbortSignal.timeout(5000)}).then(r=>{console.log('REACHED $SVC_NAME: HTTP '+r.status);process.exit(1)}).catch(e=>{console.log('BLOCKED: '+(e.cause?.code||e.name));process.exit(0)})\\\""
rc=0
for p in $SVC_NAME-allowed $SVC_NAME-denied; do
  kubectl wait pod/$p -n $NS --for=jsonpath='{.status.phase}'=Succeeded --timeout=180s >/dev/null 2>&1 || true
  echo "##### $p"; kubectl logs -n $NS $p
  phase=$(kubectl get pod $p -n $NS -o jsonpath='{.status.phase}'); echo "phase: $phase"; [ "$phase" = Succeeded ] || rc=1
done
echo "##### ingress routes to $SVC_NAME: $(kubectl get ingress -A -o json | grep -c "$SVC_NAME" || true)"
kubectl delete pod -n $NS $SVC_NAME-allowed $SVC_NAME-denied --wait=false >/dev/null; kubectl delete configmap -n $NS $SVC_NAME-tests >/dev/null
exit $rc
