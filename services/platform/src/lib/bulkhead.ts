// A bulkhead per upstream: at most `limit` calls in flight to one server, at most `maxQueue` more
// waiting, each for at most `maxWaitMs`. Timeouts already stop a slow server from holding a call
// forever; this stops it from holding many: a client sending 200 calls to a stuck server would
// otherwise keep 200 requests (and their sockets and memory) open for the full call timeout,
// while calls to the other servers are unaffected either way.
export class BusyError extends Error {}

export class Bulkhead {
  private limit: number;
  private maxQueue: number;
  private maxWaitMs: number;
  private waiting: { go: () => void; timer: NodeJS.Timeout }[] = [];
  inFlight = 0;
  constructor(limit: number, maxQueue: number, maxWaitMs: number) {
    this.limit = Math.max(1, limit); this.maxQueue = Math.max(0, maxQueue); this.maxWaitMs = maxWaitMs;
  }
  get queued() { return this.waiting.length; }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.limit) { this.inFlight++; return Promise.resolve(); }
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new BusyError(`${this.inFlight} calls in flight and ${this.waiting.length} waiting`));
    return new Promise((resolve, reject) => {
      const w = {
        go: () => { clearTimeout(w.timer); resolve(); },
        timer: setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(w), 1);
          reject(new BusyError(`${this.inFlight} calls in flight; waited ${this.maxWaitMs} ms for a free slot`));
        }, this.maxWaitMs),
      };
      this.waiting.push(w);
    });
  }

  // A finished call hands its slot straight to the next waiter, so inFlight never exceeds the limit.
  private release() {
    const next = this.waiting.shift();
    if (next) next.go(); else this.inFlight--;
  }
}
