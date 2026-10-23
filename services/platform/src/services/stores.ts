// Bonus stores, the dashboard's side (multi-store): admins write the desired state; the provisioner
// (provision/stores.ts) installs the store chart in store-<slug> and registers its MCP server as
// <slug>. The admin password stays in the store's Secret: the API gives the kubectl command to read
// it, never the password (the gateway faces the internet; it never handles store credentials).
import { count, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { stores } from '../db/schema.ts';
import { requestDelete, requestRetry } from '../provision/rows.ts';
import { HostedError, PROVISION_CHANNEL, RESERVED_TENANT_NAMES, tenantNameTaken, unregisterManaged } from './hosted.ts';
import { PREFIX_RE } from './upstreams.ts';

export type Store = typeof stores.$inferSelect;
export type StoreLimits = { max: number; baseHost: string; timeoutMs: number; homeUrlTemplate: string };
// Short menus: what the store chart and WooCommerce accept, and what the demo needs.
export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP'] as const;
export const COUNTRIES: Record<string, string> = { 'IN:KA': 'India (Karnataka)', 'US:NY': 'United States (New York)', GB: 'United Kingdom', DE: 'Germany' };
export const TIMEZONES = ['Asia/Kolkata', 'America/New_York', 'Europe/London', 'Europe/Berlin'] as const;
export type StoreInput = { slug: string; title: string; currency?: string; country?: string; timezone?: string; adminEmail?: string };

export async function createStore(db: Db, input: StoreInput, by: { id: string; email: string }, limits: StoreLimits): Promise<Store> {
  if (!PREFIX_RE.test(input.slug)) throw new HostedError(400, 'name must be 2-12 lowercase letters or digits');
  if (RESERVED_TENANT_NAMES.includes(input.slug)) throw new HostedError(400, `name "${input.slug}" is reserved`);
  const currency = input.currency ?? 'INR', country = input.country ?? 'IN:KA', timezone = input.timezone ?? 'Asia/Kolkata';
  if (!CURRENCIES.includes(currency as never)) throw new HostedError(400, `currency must be one of ${CURRENCIES.join(', ')}`);
  if (!(country in COUNTRIES)) throw new HostedError(400, `country must be one of ${Object.keys(COUNTRIES).join(', ')}`);
  if (!TIMEZONES.includes(timezone as never)) throw new HostedError(400, `timezone must be one of ${TIMEZONES.join(', ')}`);
  const row = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('urumi-tenant-names'))`);
    const taken = await tenantNameTaken(tx, input.slug);
    if (taken) throw new HostedError(409, `name "${input.slug}" is already used by ${taken}`);
    const [{ n }] = await tx.select({ n: count() }).from(stores).where(ne(stores.state, 'deleting'));
    if (n >= limits.max) throw new HostedError(409, `limit reached: at most ${limits.max} stores`);
    const [r] = await tx.insert(stores).values({
      slug: input.slug, title: input.title, host: `${input.slug}.${limits.baseHost}`, adminEmail: input.adminEmail ?? by.email,
      currency, country, timezone, createdBy: by.id, deadlineAt: new Date(Date.now() + limits.timeoutMs),
    }).returning();
    return r;
  });
  await wake(db);
  return row;
}

const wake = (db: Db) => db.execute(sql`select pg_notify(${PROVISION_CHANNEL}, 'store')`);
export const listStores = (db: Db) => db.select().from(stores).orderBy(stores.createdAt);
export const findStore = async (db: Db, id: string) => (await db.select().from(stores).where(eq(stores.id, id)).limit(1))[0];
export async function deleteStore(db: Db, id: string) { const ok = await requestDelete(db, 'stores', id); if (ok) { await unregisterManaged(db, id); await wake(db); } return ok; }
export async function retryStore(db: Db, id: string, timeoutMs: number) { const ok = await requestRetry(db, 'stores', id, timeoutMs); if (ok) await wake(db); return ok; }

export function publicStore(s: Store, limits: StoreLimits) {
  const url = limits.homeUrlTemplate.replace('{host}', s.host);
  return {
    id: s.id, slug: s.slug, title: s.title, host: s.host, url, adminUrl: `${url}/wp-admin/`, adminUser: 'admin', adminEmail: s.adminEmail,
    currency: s.currency, country: s.country, timezone: s.timezone, state: s.state, step: s.step, error: s.error, attempts: s.attempts,
    createdAt: s.createdAt, readyAt: s.readyAt, namespace: `store-${s.slug}`,
    adminPasswordCommand: `kubectl get secret -n store-${s.slug} store-secrets -o jsonpath='{.data.wp-admin-password}' | base64 -d`,
  };
}
