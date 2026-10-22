// In-process metrics in the Prometheus text format (work item 12), served on a separate port that
// the Ingress never routes (see server.ts). Per replica, like every Prometheus target.
// Rejections that cannot be attributed to a user (no key, or a key that matches nothing) are only
// counted here, not audited, so an anonymous client cannot fill the audit table.

export const counters = {
  rejectedUnauthenticated: { 'missing API key': 0, 'invalid API key': 0 } as Record<string, number>,
};

type Labels = Record<string, string>;
const key = (l: Labels) => JSON.stringify(Object.entries(l).sort());
const fmt = (l: Labels) => {
  // Sorted label names (le last, as Prometheus clients do): stable output for diffs and tests.
  const e = Object.entries(l).sort(([a], [b]) => (a === 'le' ? 1 : b === 'le' ? -1 : a.localeCompare(b)));
  return e.length ? `{${e.map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',')}}` : '';
};

class Counter {
  private values = new Map<string, { labels: Labels; value: number }>();
  readonly name: string; readonly help: string;
  constructor(name: string, help: string) { this.name = name; this.help = help; }
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    const v = this.values.get(k) ?? { labels, value: 0 };
    v.value += by; this.values.set(k, v);
  }
  render() {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`,
      ...[...this.values.values()].map(v => `${this.name}${fmt(v.labels)} ${v.value}`)].join('\n');
  }
}

class Histogram {
  private series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  readonly name: string; readonly help: string; readonly buckets: number[];
  constructor(name: string, help: string, buckets: number[]) { this.name = name; this.help = help; this.buckets = buckets; }
  observe(labels: Labels, value: number) {
    const k = key(labels);
    const s = this.series.get(k) ?? { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((b, i) => { if (value <= b) s.counts[i]! += 1; });
    s.sum += value; s.count += 1; this.series.set(k, s);
  }
  render() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket${fmt({ ...s.labels, le: String(b) })} ${s.counts[i]}`));
      out.push(`${this.name}_bucket${fmt({ ...s.labels, le: '+Inf' })} ${s.count}`);
      out.push(`${this.name}_sum${fmt(s.labels)} ${s.sum.toFixed(3)}`, `${this.name}_count${fmt(s.labels)} ${s.count}`);
    }
    return out.join('\n');
  }
}

export const toolCalls = new Counter('mcp_tool_calls_total', 'Tool calls through the gateway, by server, tool, outcome and source (mcp or chat).');
export const toolCallSeconds = new Histogram('mcp_tool_call_duration_seconds', 'Tool call duration in seconds, by server and outcome.',
  [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30]);
export const rejected = new Counter('mcp_rejected_requests_total', 'Requests to /mcp refused before reaching a tool, by reason.');
export const auditUnavailable = new Counter('mcp_audit_unavailable_total', 'Tool calls refused because the audit row could not be written, by source.');

// Gauges are read at scrape time from live state (upstream status), so they are never stale.
export type UpstreamGauge = { prefix: string; status: string; tools: number; latencyMs: number | null; inFlight?: number };

export function renderMetrics(upstreams: UpstreamGauge[]): string {
  for (const [reason, n] of Object.entries(counters.rejectedUnauthenticated)) {
    // Keep the anonymous counters (kept for /api/status) in the same family.
    rejected.inc({ reason }, n - (seen.get(reason) ?? 0)); seen.set(reason, n);
  }
  const gauge = (name: string, help: string, rows: [Labels, number][]) =>
    [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...rows.map(([l, v]) => `${name}${fmt(l)} ${v}`)].join('\n');
  return [
    toolCalls.render(),
    toolCallSeconds.render(),
    rejected.render(),
    auditUnavailable.render(),
    gauge('mcp_upstream_up', '1 if the gateway can reach the upstream MCP server (connected), else 0.',
      upstreams.map(u => [{ server: u.prefix, status: u.status }, u.status === 'connected' ? 1 : 0])),
    gauge('mcp_upstream_tools', 'Tools the upstream currently exposes.', upstreams.map(u => [{ server: u.prefix }, u.tools])),
    gauge('mcp_upstream_inflight_calls', 'Tool calls to the upstream in flight now (capped per server by the bulkhead).', upstreams.map(u => [{ server: u.prefix }, u.inFlight ?? 0])),
    gauge('mcp_upstream_health_latency_seconds', 'Duration of the last successful health check.',
      upstreams.filter(u => u.latencyMs !== null).map(u => [{ server: u.prefix }, u.latencyMs! / 1000])),
  ].join('\n\n') + '\n';
}
const seen = new Map<string, number>();
