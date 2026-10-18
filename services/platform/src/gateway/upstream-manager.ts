// Upstream MCP servers as seen by the gateway: one pooled client per upstream, a health loop that
// caches each server's tools, aggregation as "<prefix>__<tool>" and call routing with timeouts.
// A slow or dead upstream never blocks the others: tools/list answers from the cache only (G4).
import { createHash } from 'node:crypto';
import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import type { Db } from '../db/client.ts';
import type { CredentialCipher } from '../lib/crypto.ts';
import { listUpstreams, saveToolsCache, upstreamHeaders, type Upstream } from '../services/upstreams.ts';
import { sql } from 'drizzle-orm';
import { REGISTRY_CHANNEL } from '../db/client.ts';
import type { Pinning } from '../services/pins.ts';
import { classify } from '../lib/ssrf.ts';
import net from 'node:net';
import type { Outcome } from '../services/audit.ts';

export const SEPARATOR = '__';
export type Status = 'connected' | 'unreachable' | 'disabled' | 'unknown';

// Limits on what an upstream can push through the gateway. Tool names must suit strict LLM
// providers (64 chars of [a-zA-Z0-9_-]); descriptions and results are capped so one server cannot
// flood a client's or the model's context.
export const MAX_TOOL_NAME = 64;
export const MAX_DESCRIPTION = 1024;
export const MAX_RESULT_CHARS = 100_000;

// Map each upstream tool to the name clients see after "<prefix>__": invalid characters become "_";
// a name that is too long, or that collides with another after cleaning, is cut and gets the first
// 8 hex chars of the SHA-256 of the original name. Plain valid names are unchanged. Returns
// exposed suffix -> original name, used both to list and to route.
export function exposedNames(prefix: string, names: string[]): Map<string, string> {
  const room = MAX_TOOL_NAME - prefix.length - SEPARATOR.length;
  const out = new Map<string, string>();
  for (const original of names) {
    let n = original.replace(/[^A-Za-z0-9_-]/g, '_') || '_';
    if (n.length > room || out.has(n)) {
      const h = createHash('sha256').update(original).digest('hex').slice(0, 8);
      n = `${n.slice(0, room - 9)}_${h}`;
    }
    if (!out.has(n)) out.set(n, original);
  }
  return out;
}

// Upstream text shown to clients and the model: no control characters (except newline and tab),
// at most `max` characters.
export function cleanText(text: string | undefined, max = MAX_DESCRIPTION): string {
  const t = (text ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Cap a tool result: text parts share MAX_RESULT_CHARS; oversized binary parts and structured
// content are replaced by a note. Small results pass through untouched.
export function capResult(r: CallToolResult, max = MAX_RESULT_CHARS): CallToolResult {
  let left = max;
  let cut = false;
  const content = (r.content ?? []).map((c: any) => {
    if (c.type === 'text') {
      if (c.text.length <= left) { left -= c.text.length; return c; }
      cut = true;
      const text = `${c.text.slice(0, Math.max(0, left))}\n…[truncated by the gateway: result over ${max} characters]`;
      left = 0;
      return { ...c, text };
    }
    const size = JSON.stringify(c).length;
    if (size <= left) { left -= size; return c; }
    cut = true;
    return { type: 'text', text: `[${c.type} content omitted by the gateway: ${size} characters]` };
  });
  if (!cut && (!r.structuredContent || JSON.stringify(r.structuredContent).length <= max)) return r;
  const { structuredContent, ...rest } = r;
  const keep = structuredContent && JSON.stringify(structuredContent).length <= left;
  return { ...rest, ...(keep ? { structuredContent } : {}), content };
}

export type UpstreamState = {
  row: Upstream;
  status: Status;
  tools: Tool[];          // last successfully listed tools (kept while unreachable/disabled, for the dashboard)
  names: Map<string, string>;   // exposed name after "<prefix>__" -> upstream tool name
  pending: Set<string>;         // tools changed or added since an admin approved them (tool pinning)
  error: string | null;
  checkedAt: Date | null;
  latencyMs: number | null;
  failures: number;       // consecutive failed health checks
  inFlight?: Promise<void>;   // the health check running now, if any
};

// tool: the upstream's own name for the tool (exposed names may be cleaned or shortened).
export type CallResult = { result: CallToolResult; outcome: Outcome; upstream?: Upstream; tool?: string; error?: string };

type Logger = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new TimeoutError(`${what} timed out after ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(t));
}
class TimeoutError extends Error {}

const isTimeout = (e: unknown) => e instanceof TimeoutError || (e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout)
  || ['TimeoutError', 'AbortError'].includes((e as Error)?.name);

// "fetch failed" hides the useful part in cause / cause.errors (AggregateError from happy eyeballs).
export function describeError(e: unknown): string {
  const err = e as any;
  // The SSRF guard's own message says exactly what was refused and why.
  for (const c of [err, err?.cause, err?.cause?.cause]) if (c?.code === 'ESSRF') return String(c.message);
  const codes = new Set<string>();
  for (const c of [err?.cause, ...(err?.cause?.errors ?? [])]) if (c?.code) codes.add(c.code);
  const base = String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 200);
  return codes.size ? `${base} (${[...codes].join(', ')})` : base;
}

// Failures that mean "nothing is there" right now (pod gone, Service has no endpoints, bad DNS name)
// or "it rejects us" (wrong credential). These mark an upstream unreachable at once; timeouts and TLS
// hiccups only count towards the failure threshold, so one network blip does not hide its tools.
// In-cluster upstream: a Service name or an internal address. Inside a cluster a TCP handshake takes
// well under a millisecond, so a connect timeout means nothing is there. On k3s, after a Service's
// last pod disappears, new connections are dropped (not refused) for 20+ s until kube-proxy drops
// its stale rule (measured on the VPS); without this, detection waited for two 8 s timeouts.
export function isInClusterUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return /\.svc(\.cluster\.local)?$/.test(h) || (net.isIP(h) > 0 && classify(h).kind === 'internal');
  } catch { return false; }
}

export function isDefinitiveFailure(e: unknown, inCluster = false): boolean {
  const err = e as any;
  if (inCluster && [err?.code, err?.cause?.code].includes('UND_ERR_CONNECT_TIMEOUT')) return true;
  const codes = [err?.code, err?.cause?.code, ...(err?.cause?.errors ?? []).map((x: any) => x?.code)];
  // Refused, unknown host, blocked by the SSRF guard, or no route to the address: nothing is there.
  if (codes.some(c => ['ECONNREFUSED', 'ENOTFOUND', 'ESSRF', 'EHOSTUNREACH', 'ENETUNREACH'].includes(c))) return true;
  if (err?.cause?.cause?.code === 'ESSRF') return true;
  return /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(String(err?.message ?? ''));
}

const fingerprint = (u: Upstream) => JSON.stringify([u.url, u.authType, u.authHeaderName, u.credentialEnc]);

// (No constructor parameter properties: Node's type stripping only removes erasable syntax.)
class Connection {
  private client?: Client;
  private connecting?: Promise<Client>;
  private url: string;
  private headers: Record<string, string>;
  private connectTimeoutMs: number;
  private fetchFn?: typeof fetch;
  readonly key: string;
  constructor(url: string, headers: Record<string, string>, connectTimeoutMs: number, key: string, fetchFn?: typeof fetch) {
    this.url = url; this.headers = headers; this.connectTimeoutMs = connectTimeoutMs; this.key = key; this.fetchFn = fetchFn;
  }

  get(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      const c = new Client({ name: 'urumi-gateway', version: '0.1.0' });
      // fetchFn is the SSRF-guarded fetch: every connection's addresses are checked before connecting.
      const transport = new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: this.headers }, ...(this.fetchFn ? { fetch: this.fetchFn as any } : {}) });
      try {
        await withTimeout(c.connect(transport), this.connectTimeoutMs, 'connect');
      } catch (e) {
        await c.close().catch(() => {});
        throw e;
      }
      this.client = c;
      return c;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async reset() {
    const c = this.client;
    this.client = undefined;
    await c?.close().catch(() => {});
  }
}

export class UpstreamManager {
  private states = new Map<string, UpstreamState>();      // by prefix
  private conns = new Map<string, Connection>();           // by prefix
  private timer?: NodeJS.Timeout;
  private lastSignature = '';
  private running?: Promise<void>;
  private queued?: Promise<void>;

  private db: Db;
  private cipher: CredentialCipher;
  private opts: { healthIntervalMs: number; healthTimeoutMs: number; callTimeoutMs: number; healthFailureThreshold: number; fetch?: typeof fetch; pinning?: Pinning };
  private onToolsChanged: () => void;
  private log: Logger;

  constructor(db: Db, cipher: CredentialCipher, opts: UpstreamManager['opts'], onToolsChanged: () => void, log: Logger) {
    this.db = db; this.cipher = cipher; this.opts = opts; this.onToolsChanged = onToolsChanged; this.log = log;
  }

  // Health loop: every interval, reload the registry and start a check of each enabled upstream.
  // Checks run independently and are not awaited here, so one slow server (a check can take up to
  // the health timeout) never delays the others, the next tick, or a registry change.
  start() {
    const tick = async () => {
      await this.refresh().catch(e => this.log.warn({ err: describeError(e) }, 'upstream refresh failed'));
      for (const s of this.states.values()) void this.checkOnce(s);
      this.timer = setTimeout(tick, this.opts.healthIntervalMs);
    };
    void tick();
  }

  async stop() {
    clearTimeout(this.timer);
    await Promise.all([...this.conns.values()].map(c => c.reset()));
  }

  // Apply the registry as it is now. The returned promise settles after a reload that *started
  // after this call*: if one is already running (it may have read the registry before the caller's
  // change), one follow-up reload is queued and shared by all callers meanwhile.
  refresh(): Promise<void> {
    if (!this.running) {
      this.running = this.doRefresh().finally(() => { this.running = undefined; });
      return this.running;
    }
    this.queued ??= this.running.catch(() => {}).then(() => { this.queued = undefined; return this.refresh(); });
    return this.queued;
  }

  private async doRefresh() {
    const rows = await listUpstreams(this.db);
    const seen = new Set<string>();
    const changed: UpstreamState[] = [];
    for (const row of rows) {
      seen.add(row.prefix);
      const prev = this.states.get(row.prefix);
      const conn = this.conns.get(row.prefix);
      if (conn && conn.key !== fingerprint(row)) { await conn.reset(); this.conns.delete(row.prefix); }
      if (prev && prev.row.id === row.id) {
        if (fingerprint(prev.row) !== fingerprint(row) || prev.row.enabled !== row.enabled) changed.push(prev);
        // Update in place: a health check in flight holds this object and must land its result here.
        prev.row = { ...row, toolsCache: prev.row.toolsCache };
      } else {
        // Seed tools from the DB cache so the dashboard shows them before the first check (and for
        // disabled servers, which are never contacted). Only connected servers are exposed.
        const tools = (row.toolsCache as Tool[] | null) ?? [];
        const s = withNames({ row, status: 'unknown', tools, names: new Map(), pending: this.opts.pinning?.pending(row.id, tools) ?? new Set(), error: null, checkedAt: null, latencyMs: null, failures: 0 });
        this.states.set(row.prefix, s);
        changed.push(s);
      }
    }
    for (const prefix of [...this.states.keys()]) {
      if (!seen.has(prefix)) { this.states.delete(prefix); await this.conns.get(prefix)?.reset(); this.conns.delete(prefix); }
    }
    // A disabled server drops out at once, without contacting anything.
    for (const s of this.states.values()) {
      if (!s.row.enabled && s.status !== 'disabled') { s.status = 'disabled'; s.error = null; await this.conns.get(s.row.prefix)?.reset(); }
    }
    this.emitIfChanged();
    // New, edited and re-enabled servers are checked now, so the caller (e.g. POST /api/servers)
    // gets their real status. Unchanged servers wait for the health loop: re-checking them on every
    // registry change would add load and pack their failure count into a few hundred milliseconds.
    await Promise.allSettled(changed.filter(s => s.row.enabled).map(async s => {
      await s.inFlight?.catch(() => {});   // a check that started before the change used the old settings
      await this.checkOnce(s);
    }));
  }

  // Another replica saw this server go down: check it now (skipped if we already know).
  recheck(prefix: string) {
    const s = this.states.get(prefix);
    if (s && s.row.enabled && s.status !== 'unreachable') void this.checkOnce(s);
  }

  // At most one check per upstream at a time; callers during a check share it.
  private checkOnce(s: UpstreamState): Promise<void> {
    s.inFlight ??= this.check(s).catch(e => this.log.warn({ upstream: s.row.prefix, err: describeError(e) }, 'health check crashed'))
      .finally(() => { s.inFlight = undefined; if (this.states.get(s.row.prefix) === s) this.emitIfChanged(); });
    return s.inFlight;
  }

  private connection(row: Upstream): Connection {
    let c = this.conns.get(row.prefix);
    if (!c) {
      c = new Connection(row.url, upstreamHeaders(row, this.cipher), this.opts.healthTimeoutMs, fingerprint(row), this.opts.fetch);
      this.conns.set(row.prefix, c);
    }
    return c;
  }

  private async check(s: UpstreamState) {
    if (!s.row.enabled) {
      s.status = 'disabled'; s.error = null;
      await this.conns.get(s.row.prefix)?.reset();
      return;
    }
    const t0 = Date.now();
    try {
      const conn = this.connection(s.row);
      // cacheMode 'bypass': the SDK would otherwise answer from its response cache without
      // contacting the server, and a dead upstream would still look healthy.
      const listed = await withTimeout(conn.get().then(c => c.listTools(undefined, { cacheMode: 'bypass', timeout: this.opts.healthTimeoutMs })),
        this.opts.healthTimeoutMs, 'tools/list');
      if (s.status !== 'connected') this.log.info({ upstream: s.row.prefix, tools: listed.tools.length }, 'upstream connected');
      if (JSON.stringify(listed.tools) !== JSON.stringify(s.row.toolsCache)) {
        s.row = { ...s.row, toolsCache: listed.tools };
        void saveToolsCache(this.db, s.row.id, listed.tools).catch(e => this.log.warn({ err: describeError(e) }, 'tools cache write failed'));
      }
      // Tool pinning: which tools differ from what an admin approved. If the pin store cannot be
      // read, keep the previous answer rather than exposing unreviewed changes.
      const pending = this.opts.pinning
        ? await this.opts.pinning.observe(s.row.id, listed.tools).catch(e => { this.log.warn({ upstream: s.row.prefix, err: describeError(e) }, 'tool pinning check failed'); return s.pending; })
        : new Set<string>();
      if (pending.size && [...pending].some(t => !s.pending.has(t))) this.log.warn({ upstream: s.row.prefix, tools: [...pending] }, 'tools changed since approval; hidden until an admin approves them');
      Object.assign(s, { status: 'connected', tools: listed.tools, names: exposedNames(s.row.prefix, listed.tools.map(t => t.name)), pending, error: null, latencyMs: Date.now() - t0, failures: 0 });
    } catch (e) {
      // A timeout means "slow", not "broken": keep the shared connection, because closing it would
      // abort other requests in flight to this upstream. Anything else gets a fresh connection.
      if (!isTimeout(e)) await this.conns.get(s.row.prefix)?.reset();
      const error = describeError(e);
      s.failures += 1;
      // A connected upstream is only dropped after N consecutive failures, so one network blip
      // (seen with DeepWiki over Docker Desktop) does not hide its tools and churn every client's
      // tool list. An upstream that has never connected is reported unreachable at once.
      if (s.status === 'connected' && s.failures < this.opts.healthFailureThreshold && !isDefinitiveFailure(e, isInClusterUrl(s.row.url))) {
        this.log.warn({ upstream: s.row.prefix, error, failures: s.failures }, 'upstream health check failed; keeping it until the threshold');
        Object.assign(s, { error, latencyMs: null });
      } else {
        if (s.status !== 'unreachable' || s.error !== error) this.log.warn({ upstream: s.row.prefix, error, failures: s.failures }, 'upstream unreachable');
        // Tell the other replicas to check this server now instead of at their next tick, so they
        // stop listing it within about a second rather than up to one health interval later.
        if (s.status !== 'unreachable') { const prefix = s.row.prefix; void Promise.resolve().then(() => this.db.execute(sql`select pg_notify(${REGISTRY_CHANNEL}, ${`recheck:${prefix}`})`)).catch(() => {}); }
        Object.assign(s, { status: 'unreachable', error, latencyMs: null });
      }
    } finally {
      s.checkedAt = new Date();
    }
  }

  // Tools visible to MCP clients: enabled and currently connected upstreams only. `allow` filters
  // by (prefix, upstream tool name); the gateway core passes the caller's permissions.
  listTools(allow: (prefix: string, tool: string) => boolean = () => true): Tool[] {
    return [...this.states.values()]
      .filter(s => s.row.enabled && s.status === 'connected')
      .sort((a, b) => a.row.createdAt.getTime() - b.row.createdAt.getTime())
      .flatMap(s => [...s.names].flatMap(([exposed, original]) => {
        const t = s.tools.find(x => x.name === original);
        return t && !s.pending.has(original) && allow(s.row.prefix, original) ? [{
          ...t,
          name: `${s.row.prefix}${SEPARATOR}${exposed}`,
          title: t.title ? `${cleanText(t.title, 200)} (${s.row.name})` : undefined,
          description: `[${s.row.name}] ${cleanText(t.description)}`.trim(),
        }] : [];
      }));
  }

  // Re-evaluate every server against the pins (after an approval), without contacting anything.
  reapplyPins() {
    if (!this.opts.pinning) return;
    for (const s of this.states.values()) s.pending = this.opts.pinning.pending(s.row.id, s.tools);
    this.emitIfChanged();
  }

  // The current definition of one upstream tool (for approval).
  currentTool(prefix: string, tool: string): { upstream: Upstream; tool: Tool } | undefined {
    const s = this.states.get(prefix);
    const t = s?.tools.find(x => x.name === tool);
    return s && t ? { upstream: s.row, tool: t } : undefined;
  }

  private emitIfChanged() {
    const sig = this.listTools().map(t => t.name).sort().join('\n');
    if (sig !== this.lastSignature) {
      const first = this.lastSignature === '';
      this.lastSignature = sig;
      if (!first) this.log.info({ tools: sig ? sig.split('\n').length : 0 }, 'tool list changed');
      this.onToolsChanged();
    }
  }

  // Which server and upstream tool an exposed name refers to, without calling anything.
  resolve(name: string): { upstream: Upstream; tool: string } | undefined {
    const i = name.indexOf(SEPARATOR);
    const s = i > 0 ? this.states.get(name.slice(0, i)) : undefined;
    const tool = s?.names.get(name.slice(i + SEPARATOR.length));
    return s && tool ? { upstream: s.row, tool } : undefined;
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallResult> {
    const i = name.indexOf(SEPARATOR);
    const prefix = i > 0 ? name.slice(0, i) : '';
    const exposed = i > 0 ? name.slice(i + SEPARATOR.length) : '';
    const s = this.states.get(prefix);
    const tool = s?.names.get(exposed) ?? '';
    const fail = (outcome: Outcome, text: string, upstream?: Upstream): CallResult =>
      ({ result: { content: [{ type: 'text', text }], isError: true }, outcome, upstream, error: text });

    if (!s || !tool) return fail('rejected', `Unknown tool "${name}"`);
    if (!s.row.enabled) return fail('rejected', `Tool "${name}" is unavailable: server "${s.row.name}" is disabled`, s.row);
    if (tool && s.pending.has(tool)) return { ...fail('rejected', `Tool "${name}" changed since an admin approved it and is unavailable until it is approved again`, s.row), tool };
    if (s.status !== 'connected' || !tool) {
      if (s.status === 'unreachable') return fail('upstream_unreachable', `Server "${s.row.name}" is unreachable: ${s.error}`, s.row);
      return fail('rejected', `Unknown tool "${name}"`, s.row);
    }
    try {
      const client = await this.connection(s.row).get();
      const result = capResult(await client.callTool({ name: tool, arguments: args ?? {} }, { timeout: this.opts.callTimeoutMs }) as CallToolResult);
      return { result, outcome: result.isError ? 'tool_error' : 'ok', upstream: s.row, tool, error: result.isError ? textOf(result) : undefined };
    } catch (e) {
      if (isTimeout(e)) return { ...fail('timeout', `Server "${s.row.name}" did not answer within ${Math.round(this.opts.callTimeoutMs / 1000)} s (tool ${tool})`, s.row), tool };
      await this.conns.get(prefix)?.reset();
      void this.checkOnce(s);   // a failed call is a hint: check now instead of at the next tick
      return { ...fail('upstream_unreachable', `Server "${s.row.name}" failed: ${describeError(e)}`, s.row), tool };
    }
  }

  // Status for the dashboard/CLI (G7). Never includes credentials.
  snapshot() {
    return [...this.states.values()]
      .sort((a, b) => a.row.createdAt.getTime() - b.row.createdAt.getTime())
      .map(s => ({
        prefix: s.row.prefix, name: s.row.name, url: s.row.url, enabled: s.row.enabled,
        status: s.row.enabled ? s.status : 'disabled', error: s.error, failures: s.failures, checkedAt: s.checkedAt, latencyMs: s.latencyMs,
        tools: [...s.names].map(([exposed, original]) => {
          const t = s.tools.find(x => x.name === original);
          return { name: original, exposedAs: `${s.row.prefix}${SEPARATOR}${exposed}`, title: t?.title ?? null, description: cleanText(t?.description), inputSchema: t?.inputSchema ?? null, pending: s.pending.has(original) };
        }),
      }));
  }
}

function withNames(s: UpstreamState): UpstreamState {
  s.names = exposedNames(s.row.prefix, s.tools.map(t => t.name));
  return s;
}

const textOf = (r: CallToolResult) =>
  (r.content ?? []).map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ').slice(0, 300);
