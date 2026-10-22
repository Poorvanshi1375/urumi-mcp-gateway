import { Fragment, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { activityQuery, auditQuery, errorText, useMe, useOverview, useServers, useUsers, type ActivityEvent, type AuditFilter, type Outcome } from '../api';
import { Button, ButtonLink, OutcomePill, PageHeader, SummaryStrip, clock } from '../ui';

const OUTCOMES: Outcome[] = ['ok', 'tool_error', 'timeout', 'upstream_unreachable', 'rejected', 'denied', 'busy', 'pending', 'unknown'];
const Select = ({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) => (
  <label className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-1 pl-3.5 text-[13px]">
    <span className="text-muted">{label}</span>
    <select value={value} onChange={e => onChange(e.target.value)} className="max-w-[220px] truncate rounded-full bg-transparent py-0.5 pr-2 font-medium focus:outline-none">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </label>
);

export function Audit() {
  const [tab, setTab] = useState<'calls' | 'activity'>('calls');
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  return (
    <>
      <PageHeader eyebrow={tab === 'calls' ? (isAdmin ? 'Every tool call · newest first' : 'Your tool calls · newest first') : (isAdmin ? 'Every admin and account action · newest first' : 'Your account activity · newest first')}
        title="Audit log" accent="log"
        actions={<div className="flex rounded-full border border-line bg-surface p-0.5 text-[13px]" role="tablist">
          {([['calls', 'Tool calls'], ['activity', 'Activity']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`rounded-full px-3.5 py-1 ${tab === k ? 'bg-ink text-surface' : 'text-muted hover:text-ink'}`}>{l}</button>
          ))}
        </div>} />
      {tab === 'calls' ? <ToolCalls /> : <Activity />}
    </>
  );
}

// Plain-words summary of an activity row's detail; never contains secrets (the API never stores any).
function detailText(e: ActivityEvent): string {
  const d = e.detail ?? {};
  return Object.entries(d).map(([k, v]) => {
    if (v && typeof v === 'object' && 'from' in v) return `${k}: ${String((v as any).from ?? '—')} → ${String((v as any).to ?? '—')}`;
    return `${k}: ${String(v)}`;
  }).join(' · ');
}

function Activity() {
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const users = useUsers(isAdmin);
  const [actorId, setActorId] = useState<string | undefined>();
  const q = useInfiniteQuery({
    queryKey: ['activity', actorId],
    queryFn: ({ pageParam }) => activityQuery({ actorId }, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: last => (last.length === 50 ? last[last.length - 1]!.id : undefined),
    refetchInterval: 10_000,
  });
  const rows = q.data?.pages.flat() ?? [];
  return (
    <>
      {isAdmin && <div className="flex flex-wrap gap-2"><Select label="Who" value={actorId ?? ''} onChange={v => setActorId(v || undefined)}
        options={[['', 'Everyone'], ...(users.data ?? []).map(u => [u.id, u.email] as [string, string])]} /></div>}
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead><tr className="eyebrow">{['Time', 'Who', 'Action', 'Target', 'Details'].map(h => <th key={h} className="px-4 py-3 font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {q.isPending && <tr><td colSpan={5} className="px-4 py-6 text-muted">Loading…</td></tr>}
            {q.error && <tr><td colSpan={5} className="px-4 py-6 text-bad">{errorText(q.error)}</td></tr>}
            {!q.isPending && rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-muted">No activity yet.</td></tr>}
            {rows.map(e => (
              <tr key={e.id} className="border-t border-line">
                <td className="px-4 py-2.5 font-mono text-[12px] whitespace-nowrap tabular-nums" title={new Date(e.createdAt).toLocaleString()}>{clock(e.createdAt)}</td>
                <td className="px-4 py-2.5 whitespace-nowrap">{e.actorEmail ?? <span className="text-muted">unknown</span>}</td>
                <td className="px-4 py-2.5"><span className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${/failed|revoked|disabled|removed/.test(e.action) ? 'border-bad/40 text-bad' : 'border-line'}`}>{e.action.replace(/_/g, ' ')}</span></td>
                <td className="px-4 py-2.5 font-mono text-[12px]">{e.target ?? '—'}</td>
                {/* The client IP is stored but not shown: behind k3s's load balancer it is the node's internal address, not the user's. */}
                <td className="px-4 py-2.5 text-[12.5px] text-ink-2">{detailText(e) || <span className="text-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-[13px] text-muted">
        <span>Showing {rows.length}</span>
        {q.hasNextPage && <Button variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load older</Button>}
      </div>
    </>
  );
}

function ToolCalls() {
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const users = useUsers(isAdmin);
  const servers = useServers();
  const overview = useOverview();
  const c = overview.data?.calls;
  const [f, setF] = useState<AuditFilter>({});
  const [open, setOpen] = useState<number | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['audit', f],
    queryFn: ({ pageParam }) => auditQuery(f, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: last => (last.length === 50 ? last[last.length - 1]!.id : undefined),
    refetchInterval: 10_000,
  });
  const rows = q.data?.pages.flat() ?? [];

  return (
    <>
      <SummaryStrip stats={[
        { label: 'Calls · 24 h', value: c?.calls ?? '—', hint: isAdmin ? 'Everyone, MCP and chat' : 'Yours, MCP and chat' },
        { label: 'Succeeded', value: c ? c.calls - c.errors : '—', hint: c && c.calls ? `${Math.round(((c.calls - c.errors) / c.calls) * 100)}% of calls` : ' ', tone: 'ok' },
        { label: 'Failed', value: c ? c.errors - c.rejected : '—', hint: 'Tool errors, timeouts, unreachable', tone: c && c.errors - c.rejected ? 'warn' : undefined },
        { label: 'Rejected', value: c?.rejected ?? '—', hint: 'Revoked keys, disabled servers, admin-only tools', tone: c?.rejected ? 'bad' : undefined },
        { label: 'Latency', value: c ? `${c.avg_ms} ms` : '—', hint: c ? `p95 ${c.p95_ms} ms` : ' ' },
      ]} />
      <div className="flex flex-wrap gap-2">
        {isAdmin && <Select label="User" value={f.userId ?? ''} onChange={v => setF({ ...f, userId: v || undefined })}
          options={[['', 'All'], ...(users.data ?? []).map(u => [u.id, u.email] as [string, string])]} />}
        <Select label="Server" value={f.server ?? ''} onChange={v => setF({ ...f, server: v || undefined })}
          options={[['', 'All'], ...(servers.data ?? []).map(s => [s.prefix, s.prefix] as [string, string])]} />
        <Select label="Outcome" value={f.outcome ?? ''} onChange={v => setF({ ...f, outcome: (v || undefined) as Outcome | undefined })}
          options={[['', 'All'], ...OUTCOMES.map(o => [o, o.replace('_', ' ')] as [string, string])]} />
        {/* The same filters, as a spreadsheet-safe CSV (up to 10,000 rows). */}
        <ButtonLink className="ml-auto self-end" download
          href={`/api/audit/export.csv?${new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][])}`}>Download CSV</ButtonLink>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead><tr className="eyebrow">{['Time', 'User', 'Source', 'Server', 'Tool', 'Outcome', 'Duration'].map(h => <th key={h} className={`px-4 py-3 font-normal ${h === 'Duration' ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
          <tbody>
            {q.isPending && <tr><td colSpan={7} className="px-4 py-6 text-muted">Loading…</td></tr>}
            {q.error && <tr><td colSpan={7} className="px-4 py-6 text-bad">{errorText(q.error)}</td></tr>}
            {!q.isPending && rows.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-muted">No calls match these filters.</td></tr>}
            {rows.map(r => (
              <Fragment key={r.id}>
                <tr onClick={() => setOpen(open === r.id ? null : r.id)} className={`cursor-pointer border-t border-line hover:bg-page/70 ${open === r.id ? 'bg-page/70' : ''}`}>
                  <td className="px-4 py-2.5 font-mono text-[12px] whitespace-nowrap tabular-nums">{clock(r.at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{r.user ?? <span className="font-mono text-[12px] text-muted">{r.keyPrefix ? `unknown key ${r.keyPrefix}` : 'no key'}</span>}</td>
                  <td className="px-4 py-2.5"><span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] uppercase">{r.source}</span></td>
                  <td className="px-4 py-2.5 font-mono text-[12px]">{r.server ?? '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-[12px]">{r.tool ?? '—'}</td>
                  <td className="px-4 py-2.5"><OutcomePill outcome={r.outcome} /></td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12px] whitespace-nowrap tabular-nums">{r.durationMs === null ? '—' : `${r.durationMs.toLocaleString()} ms`}</td>
                </tr>
                {open === r.id && (
                  <tr className="bg-page/70"><td colSpan={7} className="px-4 pb-3 font-mono text-[12px] text-ink-2">
                    {r.error ? <>error: <span className={r.outcome === 'ok' ? '' : 'text-bad'}>{r.error}</span></> : 'no error'}
                    {r.keyPrefix && (r.keyPrefix.startsWith('oauth:') ? <> · via {r.keyPrefix.slice(6)} (OAuth)</> : <> · key {r.keyPrefix}…</>)}{r.requestId && <> · request <span className="font-mono" title={r.requestId}>{r.requestId.slice(0, 8)}</span></>} · {new Date(r.at).toLocaleString()}
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-[13px] text-muted">
        <span>Showing {rows.length}</span>
        {q.hasNextPage && <Button variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load older</Button>}
      </div>
    </>
  );
}
