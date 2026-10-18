// Token bucket per key (work item 12): `burst` requests at once, refilled at `perMinute`.
// In memory, so each gateway replica limits on its own: with N replicas behind a round-robin
// load balancer a key gets up to N times the rate. A shared store (Redis) would make it exact.
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
