{{/*
An internal MCP upstream (our own servers): Deployment + ClusterIP Service + NetworkPolicy that
admits only the gateway's pods (app=<allowedClientApp> in this release). The bearer token comes
from the platform Secret.
Usage:
  include "urumi-platform.mcpUpstream" (dict "ctx" . "component" "woo-mcp" "cfg" .Values.wooMcp
    "tokenKey" "woo-mcp-token" "extraEnv" (include "some.env" .) "readinessTimeout" 10
    "egress" (include "some.egressRules" .))     # omitted: no egress at all
*/}}
{{- define "urumi-platform.mcpUpstream" -}}
{{- $ := .ctx }}
{{- $w := .cfg }}
{{- $component := .component }}
{{- $name := printf "%s-%s" (include "urumi-platform.fullname" $) $component }}
{{- $labels := include "urumi-platform.componentLabels" (dict "ctx" $ "component" $component) }}
{{- $selector := include "urumi-platform.componentSelector" (dict "ctx" $ "component" $component) }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  namespace: {{ $.Release.Namespace }}
  labels:
    {{- $labels | nindent 4 }}
spec:
  replicas: 1
  selector:
    matchLabels:
      {{- $selector | nindent 6 }}
  template:
    metadata:
      labels:
        {{- $labels | nindent 8 }}
    spec:
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: {{ $component }}
          # Let the Service/Ingress stop routing here before the process exits (no 502s on rollout).
          lifecycle:
            preStop:
              exec: { command: ["sleep", "5"] }
          image: "{{ $w.image.repository }}:{{ required (printf "image tag for %s is required (infra/scripts/build-image.sh %s)" $component $component) $w.image.tag }}"
          imagePullPolicy: {{ $w.image.pullPolicy }}
          env:
            - { name: PORT, value: "8080" }
            {{- with .extraEnv }}
            {{- . | nindent 12 }}
            {{- end }}
            - name: MCP_BEARER_TOKEN
              valueFrom:
                secretKeyRef: { name: {{ include "urumi-platform.secretName" $ }}, key: {{ .tokenKey }} }
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 10
            timeoutSeconds: {{ .readinessTimeout | default 5 }}
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 20
            timeoutSeconds: 5
          resources:
            {{- toYaml $w.resources | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  namespace: {{ $.Release.Namespace }}
  labels:
    {{- $labels | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- $selector | nindent 4 }}
  ports:
    - name: http
      port: 8080
      targetPort: http
---
# W4/G5: only the gateway (pods labelled app=<allowedClientApp> in this release) may connect.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ $name }}
  namespace: {{ $.Release.Namespace }}
  labels:
    {{- $labels | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- $selector | nindent 6 }}
  # Egress is denied too, except what .egress lists: a compromised MCP server cannot reach the
  # databases, other pods or the internet.
  policyTypes: ["Ingress", "Egress"]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/instance: {{ $.Release.Name }}
              app: {{ $w.allowedClientApp }}
      ports:
        - port: 8080
          protocol: TCP
  egress:
    {{- with .egress }}
    {{- . | nindent 4 }}
    {{- else }} []
    {{- end }}
{{- end }}
