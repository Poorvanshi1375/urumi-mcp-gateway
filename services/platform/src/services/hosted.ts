// Hosted MCP servers, the dashboard's side (stand-out 5): admins write the desired state here and
// the provisioner (provisioner.ts, provision/hosted.ts) does the rest. The gateway itself never
// touches Kubernetes. Secret env is encrypted like upstream credentials; only its names are ever
// returned.
import { and, count, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { hostedServers, stores, upstreams } from '../db/schema.ts';
import type { CredentialCipher } from '../lib/crypto.ts';
import { checkImage } from '../lib/image-ref.ts';
import { requestDelete, requestRetry } from '../provision/rows.ts';
import { deleteUpstream, PREFIX_RE } from './upstreams.ts';

export type Hosted = typeof hostedServers.$inferSelect;
export const PROVISION_CHANNEL = 'urumi_provision';
export const RESERVED_TENANT_NAMES = ['gateway', 'store', 'mcp'];
export const SIZES = ['small', 'medium', 'large'] as const;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ENV_MAX = 32;
const reservedEnv = (k: string) => ['PORT', 'MCP_BEARER_TOKEN', 'PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD'].includes(k) || k.startsWith('KUBERNETES_');

export class HostedError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type HostedInput = {
  prefix: string; name: string; image: string; port?: number; path?: string; transport?: 'http' | 'stdio'; command?: string[];
  env?: Record<string, string>; secretEnv?: Record<string, string>; size?: (typeof SIZES)[number]; needsInternet?: boolean;
};
export type HostedLimits = { allowedImages: string[]; maxServers: number; timeoutMs: number };

function checkEnv(what: string, env: Record<string, string> | undefined) {
  const keys = Object.keys(env ?? {});
  if (keys.length > ENV_MAX) throw new HostedError(400, `${what}: at most ${ENV_MAX} variables`);
  for (const k of keys) {
    if (!ENV_NAME.test(k)) throw new HostedError(400, `${what}: "${k}" is not a valid name (A-Z, 0-9, _; not starting with a digit)`);
    if (reservedEnv(k)) throw new HostedError(400, `${what}: ${k} is set by the platform or not allowed`);
    if (String(env![k]).length > 4000) throw new HostedError(400, `${what}: ${k} is longer than 4000 characters`);
  }
}

// A prefix (or a store slug) must be free in all three places that name tools and namespaces. The
// caller holds the tenant-name lock.
export async function tenantNameTaken(db: Pick<Db, 'select'>, name: string): Promise<string | null> {
  const [u] = await db.select({ n: count() }).from(upstreams).where(eq(upstreams.prefix, name));
  if (u.n) return 'a server';
  const [h] = await db.select({ n: count() }).from(hostedServers).where(eq(hostedServers.prefix, name));
  if (h.n) return 'a hosted server';
  const [s] = await db.select({ n: count() }).from(stores).where(eq(stores.slug, name));
  return s.n ? 'a store' : null;
}

export async function createHosted(db: Db, cipher: CredentialCipher, input: HostedInput, by: string, limits: HostedLimits): Promise<Hosted> {
  if (!PREFIX_RE.test(input.prefix)) throw new HostedError(400, 'prefix must be 2-12 lowercase letters or digits');
  if (RESERVED_TENANT_NAMES.includes(input.prefix)) throw new HostedError(400, `prefix "${input.prefix}" is reserved`);
  let image: string;
  try { image = checkImage(input.image, limits.allowedImages).full; } catch (e) { throw new HostedError(400, (e as Error).message); }
  checkEnv('env', input.env);
  checkEnv('secret env', input.secretEnv);
  const transport = input.transport ?? 'http';
  if (transport === 'stdio' && !input.command?.length) throw new HostedError(400, 'a stdio server needs its command, e.g. ["node", "server.js"]');
  if (transport === 'http' && input.command?.length) throw new HostedError(400, 'a command is only used for stdio servers (an http server runs its image as it is)');
  const row = await db.transaction(async tx => {
    // One create at a time: the name check and the limit count below cannot race another create.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('urumi-tenant-names'))`);
    const taken = await tenantNameTaken(tx, input.prefix);
    if (taken) throw new HostedError(409, `prefix "${input.prefix}" is already used by ${taken}`);
    const [{ n }] = await tx.select({ n: count() }).from(hostedServers).where(ne(hostedServers.state, 'deleting'));
    if (n >= limits.maxServers) throw new HostedError(409, `limit reached: at most ${limits.maxServers} hosted servers`);
    const secret = input.secretEnv && Object.keys(input.secretEnv).length ? cipher.encrypt(JSON.stringify(input.secretEnv)) : null;
    const [r] = await tx.insert(hostedServers).values({
      prefix: input.prefix, name: input.name, image, port: input.port ?? 8080, path: input.path ?? '/mcp', env: input.env ?? {},
      transport, command: transport === 'stdio' ? input.command : null,
      secretEnvEnc: secret, size: input.size ?? 'small', needsInternet: input.needsInternet ?? false, createdBy: by,
      deadlineAt: new Date(Date.now() + limits.timeoutMs),
    }).returning();
    return r;
  });
  await wake(db);
  return row;
}

export const wake = (db: Db) => db.execute(sql`select pg_notify(${PROVISION_CHANNEL}, 'hosted')`);
export const listHosted = (db: Db) => db.select().from(hostedServers).orderBy(hostedServers.createdAt);
export const findHosted = async (db: Db, id: string) => (await db.select().from(hostedServers).where(eq(hostedServers.id, id)).limit(1))[0];

// Delete: the tools go at once, here, whatever the provisioner is busy with (its own unregister step
// then finds nothing to do); the namespace and the row follow.
export async function unregisterManaged(db: Db, managedId: string) {
  const [row] = await db.select({ prefix: upstreams.prefix }).from(upstreams).where(eq(upstreams.managedId, managedId)).limit(1);
  if (row) await deleteUpstream(db, row.prefix, { managed: true });
}
export async function deleteHosted(db: Db, id: string): Promise<boolean> {
  const ok = await requestDelete(db, 'hosted_servers', id);
  if (ok) { await unregisterManaged(db, id); await wake(db); }
  return ok;
}
export async function retryHosted(db: Db, id: string, timeoutMs: number): Promise<boolean> {
  const ok = await requestRetry(db, 'hosted_servers', id, timeoutMs);
  if (ok) await wake(db);
  return ok;
}

// What admins see: never a secret value, only the names of the secret env.
export function publicHosted(h: Hosted, cipher: CredentialCipher) {
  let secretEnvKeys: string[] = [];
  try { secretEnvKeys = h.secretEnvEnc ? Object.keys(JSON.parse(cipher.decrypt(h.secretEnvEnc))) : []; } catch { secretEnvKeys = ['(unreadable)']; }
  return {
    id: h.id, prefix: h.prefix, name: h.name, image: h.image, transport: h.transport, command: h.command, port: h.port, path: h.path, env: h.env, secretEnvKeys,
    size: h.size, needsInternet: h.needsInternet, state: h.state, step: h.step, error: h.error, attempts: h.attempts,
    createdAt: h.createdAt, readyAt: h.readyAt, deadlineAt: h.deadlineAt, namespace: `mcp-${h.prefix}`,
    url: `http://mcp.mcp-${h.prefix}.svc.cluster.local:${h.port}${h.path}`,
  };
}

// The name a server registered by URL wants: refused if a hosted server or store has it.
export async function tenantNameConflict(db: Db, prefix: string): Promise<string | null> {
  const [h] = await db.select({ n: count() }).from(hostedServers).where(eq(hostedServers.prefix, prefix));
  if (h.n) return 'a hosted server';
  const [s] = await db.select({ n: count() }).from(stores).where(and(eq(stores.slug, prefix)));
  return s.n ? 'a store' : null;
}
