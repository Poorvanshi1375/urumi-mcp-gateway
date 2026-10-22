// The provisioner's step machine (T1-2/T1-3), shared by hosted servers and stores. A row holds the
// desired state; one reconcile pass runs its steps in order from the top. Every step is idempotent
// (server-side apply, "create if absent", helm upgrade --install), so after a crash or a leader
// change the next pass simply runs them again. This module only decides what the row becomes; the
// caller does the database write (provision/rows.ts: a compare-and-set on the row's state and
// lease) and owns the clock, which keeps it testable without a cluster. Retry and Delete requests
// are rows.ts's requestRetry and requestDelete.

export type State = 'provisioning' | 'ready' | 'failed' | 'deleting';
// done: the step's work is in place. wait: started but not finished yet (a pod still starting):
// try again on the next pass, without counting an attempt.
export type StepResult = 'done' | { wait: string };
export type Step<C> = { name: string; run: (ctx: C) => Promise<StepResult> };

export type Row = {
  state: State;
  step: string | null;           // last completed step
  error: string | null;          // short, redacted; shown in the dashboard
  attempts: number;              // consecutive failed passes
  deadlineAt: Date | null;       // provisioning must be ready by then
  nextAttemptAt: Date | null;    // backoff: no pass before then
};
export type Patch = Partial<Row> & { readyAt?: Date; gone?: true };

export const BACKOFF_MS = [5_000, 15_000, 45_000];   // then failed (provisioning) or every 45 s (deleting)

// What a pass needs from its caller besides the steps.
export type PassOptions = { now: Date; secrets?: string[]; hint?: () => Promise<string | null> };

// Remove secret material from a message before it is stored or shown: the given values, bearer
// tokens, WooCommerce keys, and long runs that look generated: base64 or base64url with upper and
// lower case and digits, or pure hex. Kubernetes names are lowercase, so a message naming a pod
// ("platform-ship-mcp-699668f98d-tkldk") stays readable.
const looksGenerated = (t: string) => /^[a-f0-9]+$/i.test(t) || (/[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t));
export function redact(message: string, secrets: string[] = []): string {
  let s = message;
  for (const v of secrets) if (v && v.length >= 6) s = s.split(v).join('[redacted]');
  return s
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b(ck|cs)_[a-f0-9]{20,}\b/g, '$1_[redacted]')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, t => (looksGenerated(t.replace(/=+$/, '')) ? '[redacted]' : t))
    .slice(0, 400);
}

// One pass over a row that is provisioning (or a retry of a failed one): run the steps until one
// waits or throws. Returns the patch for the row.
export async function provisionPass<C>(row: Row, steps: Step<C>[], ctx: C, o: PassOptions): Promise<Patch> {
  const { now } = o;
  if (row.nextAttemptAt && row.nextAttemptAt > now) return {};
  const deadlineAt = row.deadlineAt;
  let last: string | null = null;
  try {
    for (const s of steps) {
      const r = await s.run(ctx);
      if (r !== 'done') {
        // Still coming up. Past the deadline that is a failure, with the cluster's own reason
        // (for example the pod's last Warning event: ImagePullBackOff, CrashLoopBackOff).
        if (deadlineAt && now >= deadlineAt) {
          const hint = await o.hint?.().catch(() => null);
          return { state: 'failed', step: last, error: redact(`timed out at ${s.name}: ${r.wait}${hint ? ` (${hint})` : ''}`, o.secrets), nextAttemptAt: null };
        }
        return { step: last, error: null, attempts: 0, nextAttemptAt: null };
      }
      last = s.name;
    }
  } catch (e) {
    const attempts = row.attempts + 1;
    const error = redact(`${stepAfter(steps, last)}: ${(e as Error).message}`, o.secrets);
    if (attempts > BACKOFF_MS.length || (deadlineAt && now >= deadlineAt)) return { state: 'failed', step: last, error, attempts, nextAttemptAt: null };
    return { step: last, error, attempts, nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[attempts - 1]) };
  }
  return { state: 'ready', step: last, error: null, attempts: 0, nextAttemptAt: null, readyAt: now };
}

// One pass over a row being deleted: the teardown steps in order (tools first, then the cluster
// objects, then the row). A delete never gives up: on an error it is retried, at most every 45 s,
// with the error shown, because leaving half a tenant behind is worse than trying again.
export async function deletePass<C>(row: Row, steps: Step<C>[], ctx: C, o: PassOptions): Promise<Patch> {
  const { now } = o;
  if (row.nextAttemptAt && row.nextAttemptAt > now) return {};
  let last: string | null = null;
  try {
    for (const s of steps) {
      const r = await s.run(ctx);
      if (r !== 'done') return { step: last, error: null, attempts: 0, nextAttemptAt: null };
      last = s.name;
    }
  } catch (e) {
    const attempts = row.attempts + 1;
    return { step: last, error: redact(`${stepAfter(steps, last)}: ${(e as Error).message}`, o.secrets), attempts,
      nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]) };
  }
  return { gone: true };
}

const stepAfter = <C>(steps: Step<C>[], last: string | null) => steps[last ? steps.findIndex(s => s.name === last) + 1 : 0]?.name ?? 'finish';
