// Upstream MCP server registry (G1). Credentials are encrypted at rest and never returned to
// callers; every change NOTIFYs gateway processes so they reload at once.
import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { REGISTRY_CHANNEL } from '../db/client.ts';
import { upstreams } from '../db/schema.ts';
import type { CredentialCipher } from '../lib/crypto.ts';
import { deleteServerRules, renameServerRules } from './permissions.ts';

export type Upstream = typeof upstreams.$inferSelect;
export type AuthType = 'none' | 'bearer' | 'header';

export type UpstreamInput = {
  prefix: string;
  name: string;
  url: string;
  authType: AuthType;
  authHeaderName?: string | null;
  credential?: string | null;
  enabled?: boolean;
  trustAnnotations?: boolean;
};

export const PREFIX_RE = /^[a-z0-9]{2,12}$/;

// Rows the provisioner registers (managed_by set) follow their hosted server or store: their
// address and credential come from the provisioner and the tenant's namespace, so they cannot be
// edited, and removing one directly would leave the tenant running. Name, enabled and trust stay
// editable like any server.
export class ManagedRowError extends Error {}
const MANAGED_FIXED = ['prefix', 'url', 'authType', 'authHeaderName', 'credential'] as const;
const managedWhat = (u: Upstream) => (u.managedBy === 'store' ? 'store' : 'hosted server');

const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive',
  'upgrade', 'te', 'trailer', 'expect', 'cookie', 'set-cookie', 'accept', 'accept-encoding', 'origin', 'referer', 'forwarded',
  'x-real-ip', 'last-event-id', 'traceparent', 'tracestate', 'user-agent']);

function validate(input: Partial<UpstreamInput>) {
  if (input.prefix !== undefined && !PREFIX_RE.test(input.prefix)) throw new Error('prefix must be 2-12 lowercase letters or digits');
  // "gateway" names the gateway's own tools (tool search mode).
  if (input.prefix === 'gateway') throw new Error('prefix "gateway" is reserved');
  if (input.url !== undefined) {
    const u = new URL(input.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('url must be http(s)');
    // Credentials belong in the write-only credential field, never in the URL, which members can
    // not see but admins and logs can.
    if (u.username || u.password) throw new Error('url must not contain a user name or password; use the credential field');
    if (u.search || u.hash) throw new Error('url must not contain a query string or fragment; put tokens in the credential field');
  }
  if (input.authType === 'header' && !input.authHeaderName) throw new Error('authHeaderName is required for header auth');
  // The credential header must not be one the HTTP or MCP layers set or read themselves: as a
  // credential it would replace or confuse them (request smuggling, a wrong protocol version,
  // a hijacked session, a forged client address).
  const h = input.authHeaderName?.toLowerCase();
  if (h && (RESERVED_HEADERS.has(h) || /^(proxy-|sec-|x-forwarded-|mcp-)/.test(h))) {
    throw new Error(`authHeaderName "${input.authHeaderName}" is reserved; use another header name (or bearer auth for Authorization: Bearer)`);
  }
}

const notify = (db: Db) => db.execute(sql`select pg_notify(${REGISTRY_CHANNEL}, 'changed')`);

export const listUpstreams = (db: Db) => db.select().from(upstreams).orderBy(asc(upstreams.createdAt));
export const findUpstream = async (db: Db, prefix: string) =>
  (await db.select().from(upstreams).where(eq(upstreams.prefix, prefix)).limit(1))[0];

export async function createUpstream(db: Db, cipher: CredentialCipher, input: UpstreamInput): Promise<Upstream> {
  validate(input);
  const [row] = await db.insert(upstreams).values({
    prefix: input.prefix,
    name: input.name,
    url: input.url,
    authType: input.authType,
    authHeaderName: input.authType === 'header' ? input.authHeaderName : null,
    credentialEnc: input.authType !== 'none' && input.credential ? cipher.encrypt(input.credential) : null,
    enabled: input.enabled ?? true,
    trustAnnotations: input.trustAnnotations ?? false,
  }).returning();
  await notify(db);
  return row;
}

// credential: undefined = keep the stored one; null or '' = clear it.
export async function updateUpstream(db: Db, cipher: CredentialCipher, prefix: string, patch: Partial<UpstreamInput>): Promise<Upstream | undefined> {
  validate(patch);
  const current = await findUpstream(db, prefix);
  if (current?.managedBy) {
    const fixed = MANAGED_FIXED.filter(k => patch[k] !== undefined && patch[k] !== (current as Record<string, unknown>)[k]);
    if (fixed.length) throw new ManagedRowError(`${prefix} is managed by its ${managedWhat(current)}: ${fixed.join(', ')} cannot be changed here`);
  }
  const set: Partial<typeof upstreams.$inferInsert> = { updatedAt: new Date() };
  if (patch.prefix !== undefined) set.prefix = patch.prefix;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.authType !== undefined) set.authType = patch.authType;
  if (patch.authHeaderName !== undefined) set.authHeaderName = patch.authHeaderName;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.trustAnnotations !== undefined) set.trustAnnotations = patch.trustAnnotations;
  if (patch.credential !== undefined) set.credentialEnc = patch.credential ? cipher.encrypt(patch.credential) : null;
  if (patch.authType === 'none') set.credentialEnc = null;
  const [row] = await db.update(upstreams).set(set).where(eq(upstreams.prefix, prefix)).returning();
  if (row && patch.prefix !== undefined && patch.prefix !== prefix) await renameServerRules(db, prefix, patch.prefix);
  if (row) await notify(db);
  // Trusting the hints changes what members see (member default readOnly): reload as for a rule change.
  if (row && patch.trustAnnotations !== undefined) await db.execute(sql`select pg_notify(${REGISTRY_CHANNEL}, 'permissions')`);
  return row;
}

// opts.managed: the provisioner's own teardown, the only way a managed row is removed.
export async function deleteUpstream(db: Db, prefix: string, opts: { managed?: boolean } = {}): Promise<boolean> {
  const current = await findUpstream(db, prefix);
  if (current?.managedBy && !opts.managed) throw new ManagedRowError(`${prefix} is managed by its ${managedWhat(current)}: delete the ${managedWhat(current)} instead`);
  const rows = await db.delete(upstreams).where(eq(upstreams.prefix, prefix)).returning({ id: upstreams.id });
  if (rows.length) { await deleteServerRules(db, prefix); await notify(db); }
  return rows.length > 0;
}

// Remember the last tool list seen, for the dashboard (G7). Not a registry change: no NOTIFY.
export async function saveToolsCache(db: Db, id: string, tools: unknown[]) {
  await db.update(upstreams).set({ toolsCache: tools, toolsCachedAt: new Date() }).where(eq(upstreams.id, id));
}

// Headers the gateway sends upstream. Only ever used server-side (G5).
export function upstreamHeaders(u: Upstream, cipher: CredentialCipher): Record<string, string> {
  if (u.authType === 'none' || !u.credentialEnc) return {};
  const secret = cipher.decrypt(u.credentialEnc);
  return u.authType === 'bearer' ? { authorization: `Bearer ${secret}` } : { [u.authHeaderName!.toLowerCase()]: secret };
}

// What admins see: never the credential, only whether one is set (G5).
export const publicUpstream = (u: Upstream) => ({
  id: u.id, prefix: u.prefix, name: u.name, url: u.url, authType: u.authType, authHeaderName: u.authHeaderName,
  hasCredential: Boolean(u.credentialEnc), enabled: u.enabled, trustAnnotations: u.trustAnnotations, managedBy: u.managedBy, createdAt: u.createdAt, updatedAt: u.updatedAt,
});
