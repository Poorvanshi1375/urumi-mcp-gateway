import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
// Token bucket per key (work item 12): `burst` requests at once, refilled at `perMinute`.
// RateLimiter is in memory, so on its own each replica limits separately (N replicas would give a
// key N times the rate). SharedRateLimiter below keeps the buckets in Postgres, which makes the
// limit exact across replicas, and falls back to a RateLimiter if Postgres cannot answer.
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private perMs: number;
  readonly perMinute: number;
  readonly burst: number;
  constructor(perMinute: number, burst: number) {
    this.perMinute = perMinute; this.burst = Math.max(1, burst); this.perMs = perMinute / 60_000;
    // Forget keys that have been idle long enough to be full again.
    setInterval(() => {
      const now = Date.now();
      for (const [k, b] of this.buckets) if (b.tokens + (now - b.at) * this.perMs >= this.burst) this.buckets.delete(k);
    }, 60_000).unref();
  }

  // Would take() succeed now? Consumes nothing (for limits that count only failures).
  peek(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number } {
    if (this.perMinute <= 0) return { ok: true };
    const b = this.buckets.get(key);
    if (!b) return { ok: true };
    const tokens = Math.min(this.burst, b.tokens + (now - b.at) * this.perMs);
    return tokens >= 1 ? { ok: true } : { ok: false, retryAfterS: Math.ceil((1 - tokens) / this.perMs / 1000) };
  }

  // { ok: true } or { ok: false, retryAfterS } for a refused request. perMinute 0 = no limit.
  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number } {
    if (this.perMinute <= 0) return { ok: true };
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) * this.perMs);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfterS: Math.ceil((1 - b.tokens) / this.perMs / 1000) };
  }
}

// One bucket per subject in Postgres, updated in a single statement, so replicas share it exactly.
// The refill is computed from updated_at, which moves only when a request is let through: a
// refused request changes nothing, so hammering an empty bucket cannot push its refill back.
// Postgres's clock is the only clock used, so replica clock skew does not matter. The row lock
// of INSERT ... ON CONFLICT DO UPDATE serialises concurrent requests for one subject.
export class SharedRateLimiter {
  private db: Db;
  private fallback: RateLimiter;
  private onError: (e: unknown) => void;
  private lastPrune = 0;
  readonly perMinute: number;
  readonly burst: number;
  constructor(db: Db, perMinute: number, burst: number, onError: (e: unknown) => void) {
    this.db = db; this.perMinute = perMinute; this.burst = Math.max(1, burst); this.onError = onError;
    this.fallback = new RateLimiter(perMinute, burst);
  }

  async take(subject: string): Promise<{ ok: true } | { ok: false; retryAfterS: number }> {
    if (this.perMinute <= 0) return { ok: true };
    const perSec = this.perMinute / 60, burst = this.burst;
    const refilled = sql`least(${burst}::float8, b.tokens + extract(epoch from now() - b.updated_at) * ${perSec}::float8)`;
    try {
      const r = (await this.db.execute(sql`
        insert into rate_buckets as b (subject, tokens, updated_at) values (${subject}, ${burst - 1}::float8, now())
        on conflict (subject) do update set
          tokens = case when ${refilled} >= 1 then ${refilled} - 1 else b.tokens end,
          updated_at = case when ${refilled} >= 1 then now() else b.updated_at end
        returning (b.updated_at = now()) as granted, ${refilled} as available`)).rows[0] as { granted: boolean; available: number };
      if (Date.now() - this.lastPrune > 300_000) {   // idle buckets are full again: no need to keep them
        this.lastPrune = Date.now();
        void this.db.execute(sql`delete from rate_buckets where updated_at < now() - interval '1 hour'`).catch(() => {});
      }
      return r.granted ? { ok: true } : { ok: false, retryAfterS: Math.max(1, Math.ceil((1 - Number(r.available)) / perSec)) };
    } catch (e) {
      // Fail open to the per-replica limit: a database hiccup should not turn into refused calls.
      this.onError(e);
      return this.fallback.take(subject);
    }
  }
}

