// Typed client for the platform's /api (same origin; the session cookie authenticates).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type Role = 'admin' | 'member';
export type User = { id: string; email: string; name: string | null; role: Role; createdAt: string; disabledAt: string | null };
// exposedAs: the name clients see (<prefix>__<name>, cleaned to 64 chars); memberAllowed: members may use it.
// pending: changed (or new) since an admin approved it, so hidden from clients (tool pinning);
// approved: the approved version, sent to admins for the review diff.
export type ToolDefinition = { title: string | null; description: string; inputSchema: unknown; outputSchema?: unknown; annotations?: unknown };
export type Tool = { name: string; title?: string | null; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown; exposedAs?: string; memberAllowed?: boolean; flags?: string[]; invalid?: string | null;
  chatConfirm?: 'auto' | 'always' | 'never'; asksInChat?: boolean;
  pending?: boolean; approved?: ToolDefinition | null };
export type Features = { toolPinning: boolean; toolSearch: boolean; oauth: boolean; validateArguments?: boolean; provisioner?: boolean; memberDefault?: 'allow' | 'readOnly' };
export type ChatStatus = { enabled: boolean; model: string | null; tools: number; toolNames?: string[]; confirmWrites?: boolean };
export const useChatStatus = () => useQuery({ queryKey: ['chat-status'], queryFn: () => api<ChatStatus>('GET', '/api/chat/status') });
export const useFeatures = () => useQuery({ queryKey: ['features'], queryFn: () => api<Features>('GET', '/api/features'), staleTime: 60_000 });
export type ServerStatus = 'connected' | 'unreachable' | 'disabled' | 'unknown';
export type AuthType = 'none' | 'bearer' | 'header';
// url is null for members: only admins see where an upstream lives.
export type Server = {
  id: string; prefix: string; name: string; url: string | null; authType: AuthType; authHeaderName: string | null;
  hasCredential: boolean; enabled: boolean; createdAt: string; updatedAt: string;
  status: ServerStatus; error: string | null; checkedAt: string | null; latencyMs: number | null; tools: Tool[];
  pinned: boolean;   // tool pinning applies (off for the servers deployed with the platform)
  managedBy?: 'hosted' | 'store' | null;   // registered by the provisioner: address and credential fixed
  trustAnnotations: boolean;     // an admin vouched for this server's read-only hints
  annotationsTrusted: boolean;   // the gateway acts on them: trusted, or deployed with the platform
  lastOutage: { from: string; to: string | null; reason: string } | null; outages: number;   // seen by the replica that answered
};
// The tools this user can actually call: everything for admins; for members, the ones an admin
// has not restricted (the gateway hides the rest from /mcp and from the chat agent too).
// Tools waiting for re-approval (tool pinning) are hidden from everyone.
export const usableTools = (s: Server, role: Role | undefined) => s.tools.filter(t => !t.pending && (role === 'admin' || t.memberAllowed !== false));
export type ApiKey = { id: string; name: string; prefix: string; userId: string; email: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
export type Outcome = 'ok' | 'tool_error' | 'timeout' | 'upstream_unreachable' | 'rejected' | 'denied' | 'busy' | 'pending' | 'unknown';
export type AuditEvent = {
  id: number; at: string; userId: string | null; user: string | null; keyPrefix: string | null; source: 'mcp' | 'chat';
  server: string | null; tool: string | null; durationMs: number | null; outcome: Outcome; error: string | null; requestId?: string | null;
};
export type Invite = { id: string; email: string; role: Role; createdAt: string; expiresAt: string; acceptedAt: string | null; status: 'pending' | 'accepted' | 'expired' };

export class ApiError extends Error {
  status: number;
  issues: { path: string; message: string }[];
  constructor(status: number, message: string, issues: { path: string; message: string }[] = []) {
    super(message); this.status = status; this.issues = issues;
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // Proxies answer some failures with HTML (e.g. Traefik's 502 during a rollout): don't choke on it.
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) throw new ApiError(res.status, data.error ?? (res.status >= 502 ? 'The gateway is not reachable right now. Try again in a moment.' : `Request failed (${res.status})`), data.issues);
  return data as T;
}

// ---- queries
export const useMe = () => useQuery({
  queryKey: ['me'],
  queryFn: () => api<{ user: User }>('GET', '/api/me').then(r => r.user),
  retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2,
  staleTime: 60_000,
});
export const useServers = () => useQuery({
  queryKey: ['servers'],
  queryFn: () => api<{ servers: Server[] }>('GET', '/api/servers').then(r => r.servers),
  refetchInterval: 5000,   // status changes (disable, dead upstream) appear without a reload
});
export const useKeys = (all = false) => useQuery({
  queryKey: ['keys', all],
  queryFn: () => api<{ keys: ApiKey[] }>('GET', `/api/keys${all ? '?all=1' : ''}`).then(r => r.keys),
});
// OAuth: apps a user connected with a browser sign-in (Claude Code and other MCP clients).
export type Grant = { id: string; client: string; userId: string; email: string; createdAt: string; lastUsedAt: string | null };
export const useGrants = (enabled: boolean, all = false) => useQuery({
  queryKey: ['grants', all], enabled,
  queryFn: () => api<{ grants: Grant[] }>('GET', `/api/oauth/grants${all ? '?all=1' : ''}`).then(r => r.grants),
});
export const useUsers = (enabled = true) => useQuery({
  queryKey: ['users'], enabled,
  queryFn: () => api<{ users: User[] }>('GET', '/api/users').then(r => r.users),
});
export const useInvites = (enabled = true) => useQuery({
  queryKey: ['invites'], enabled,
  queryFn: () => api<{ invites: Invite[] }>('GET', '/api/invites').then(r => r.invites),
});
export type AuditFilter = { userId?: string; server?: string; outcome?: Outcome };
export const auditQuery = (f: AuditFilter, before?: number) => {
  const q = new URLSearchParams({ limit: '50' });
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  if (before) q.set('before', String(before));
  return api<{ events: AuditEvent[] }>('GET', `/api/audit?${q}`).then(r => r.events);
};

// Admin and account actions (sign-ins, keys, invites, users, servers, permissions).
export type ActivityEvent = { id: number; createdAt: string; actorId: string | null; actorEmail: string | null; action: string; target: string | null; detail: Record<string, unknown> | null; ip: string | null };
export const activityQuery = (f: { actorId?: string }, before?: number) => {
  const q = new URLSearchParams({ limit: '50' });
  if (f.actorId) q.set('actorId', f.actorId);
  if (before) q.set('before', String(before));
  return api<{ events: ActivityEvent[] }>('GET', `/api/activity?${q}`).then(r => r.events);
};

export type Overview = {
  scope: 'workspace' | 'me';
  calls: { calls: number; errors: number; rejected: number; avg_ms: number; p95_ms: number };
  perServer: { server: string; calls: number; errors: number; p50_ms: number | null; p95_ms: number | null }[];
  people?: { active: number; admins: number; disabled: number; pending_invites: number; active_keys: number };
  perUser?: { id: string; active_keys: number; last_active: string | null; calls_24h: number }[];
};
export const useOverview = () => useQuery({
  queryKey: ['overview'],
  queryFn: () => api<Overview>('GET', '/api/overview'),
  refetchInterval: 15_000,
});

// ---- mutations (invalidate what they change)
export function useApiMutation<TVars, TResult = unknown>(fn: (v: TVars) => Promise<TResult>, invalidate: string[][]) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => Promise.all([...invalidate, ['overview']].map(k => qc.invalidateQueries({ queryKey: k }))) });
}

export const errorText = (e: unknown) =>
  e instanceof ApiError
    ? (e.issues.length ? e.issues.map(i => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ') : e.message)
    : e instanceof Error ? e.message : String(e);

// ---- hosted MCP servers (stand-out 5): desired state; the provisioner runs them
export type HostedState = 'provisioning' | 'ready' | 'failed' | 'deleting';
export type Hosted = {
  id: string; prefix: string; name: string; image: string; transport: string; port: number; path: string; env: Record<string, string>; secretEnvKeys: string[];
  size: 'small' | 'medium' | 'large'; needsInternet: boolean; state: HostedState; step: string | null; error: string | null; attempts: number;
  createdAt: string; readyAt: string | null; deadlineAt: string | null; namespace: string; url: string;
  server: { status: ServerStatus; tools: number } | null;
};
export type HostedList = { servers: Hosted[]; allowedImages: string[]; maxServers: number; sizes: string[] };
// Polls every 3 s while anything is starting or being removed.
export const useHosted = () => useQuery({
  queryKey: ['hosted'],
  queryFn: () => api<HostedList>('GET', '/api/hosted'),
  refetchInterval: q => (q.state.data?.servers.some(s => s.state === 'provisioning' || s.state === 'deleting') ? 3000 : 30_000),
});
