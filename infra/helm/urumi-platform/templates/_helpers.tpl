{{- define "urumi-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "urumi-platform.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "urumi-platform.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "urumi-platform.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "urumi-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "urumi-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Usage: include "urumi-platform.componentLabels" (dict "ctx" . "component" "postgres") */}}
{{- define "urumi-platform.componentLabels" -}}
{{ include "urumi-platform.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
app: {{ .component }}
{{- end }}

{{- define "urumi-platform.componentSelector" -}}
{{ include "urumi-platform.selectorLabels" .ctx }}
app: {{ .component }}
{{- end }}

{{- define "urumi-platform.secretName" -}}
{{- required "secrets.existingSecret is required: create the Secret with scripts/secrets.sh" .Values.secrets.existingSecret }}
{{- end }}

{{- define "urumi-platform.postgresHost" -}}
{{- printf "%s-postgres" (include "urumi-platform.fullname" .) }}
{{- end }}

{{- define "urumi-platform.image" -}}
{{- /* toString: an all-digit git sha passed with --set arrives as a number */}}
{{- printf "%s:%s" .Values.image.repository (toString (required "image.tag is required (see infra/scripts/build-image.sh platform)" .Values.image.tag)) }}
{{- end }}

{{/* Standard libpq env, read by node-postgres and psql alike. */}}
{{- /* The gateway's own connection (idea AC): the restricted app role when postgres.appUser is set,
otherwise the owner. Migrations always use pgEnv (the owner). */}}
{{- define "urumi-platform.pgAppEnv" -}}
{{- if .Values.postgres.appUser }}
- name: PGHOST
  value: {{ include "urumi-platform.postgresHost" . | quote }}
- name: PGPORT
  value: "5432"
- name: PGDATABASE
  value: {{ .Values.postgres.database | quote }}
- name: PGUSER
  value: {{ .Values.postgres.appUser | quote }}
- name: PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "urumi-platform.secretName" . }}
      key: app-db-password
{{- else }}
{{- include "urumi-platform.pgEnv" . }}
{{- end }}
{{- end }}

{{- define "urumi-platform.pgEnv" -}}
- name: PGHOST
  value: {{ include "urumi-platform.postgresHost" . | quote }}
- name: PGPORT
  value: "5432"
- name: PGDATABASE
  value: {{ .Values.postgres.database | quote }}
- name: PGUSER
  value: {{ .Values.postgres.user | quote }}
- name: PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "urumi-platform.secretName" . }}
      key: postgres-password
{{- end }}
