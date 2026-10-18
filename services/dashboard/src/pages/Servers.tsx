import { useState } from 'react';
import { ChevronDown, ChevronRight, KeyRound, MoreVertical, Plus, RefreshCw } from 'lucide-react';
import { api, errorText, usableTools, useApiMutation, useMe, useOverview, useServers, type AuthType, type Server, type Tool } from '../api';
import { Button, Drawer, ErrorNote, Field, PageHeader, Pill, StatusPill, SummaryStrip, Toggle, WarnNote, ago } from '../ui';

export function Servers() {
  const servers = useServers();
  const overview = useOverview();
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const [editing, setEditing] = useState<Server | 'new' | null>(null);
  const list = servers.data ?? [];
  const connected = list.filter(s => s.status === 'connected').length;
  const unreachable = list.filter(s => s.status === 'unreachable').length;
  const exposed = list.filter(s => s.enabled && s.status === 'connected').reduce((n, s) => n + usableTools(s, me.data?.role).length, 0);
  const c = overview.data?.calls;
  const callsBy = new Map((overview.data?.perServer ?? []).map(x => [x.server, x]));

  return (
    <>
      <PageHeader eyebrow={`Gateway · ${list.length} server${list.length === 1 ? '' : 's'}`} title="MCP servers" accent="servers"
        actions={<>
          <Button variant="outline" onClick={() => servers.refetch()} disabled={servers.isFetching}><RefreshCw size={14} className={servers.isFetching ? 'animate-spin' : ''} />Refresh</Button>
          {isAdmin && <Button variant="primary" onClick={() => setEditing('new')}><Plus size={15} />Add server</Button>}
        </>} />

      <SummaryStrip stats={[
        { label: 'Servers up', value: <>{connected}<span className="text-muted">/{list.filter(s => s.enabled).length}</span></>, hint: unreachable ? `${unreachable} unreachable` : 'All enabled servers answering', tone: unreachable ? 'bad' : undefined },
        { label: 'Tools live', value: exposed, hint: isAdmin ? 'All of them visible to admins' : 'Available to you' },
        { label: 'Calls · 24 h', value: c?.calls ?? '—', hint: overview.data?.scope === 'me' ? 'Your calls' : 'Everyone' },
        { label: 'Error rate · 24 h', value: c ? `${c.calls ? Math.round((c.errors / c.calls) * 100) : 0}%` : '—', hint: c ? `${c.errors} of ${c.calls} calls` : ' ', tone: c && c.calls && c.errors / c.calls > 0.2 ? 'warn' : undefined },
        { label: 'Latency p95', value: c ? `${c.p95_ms} ms` : '—', hint: c ? `avg ${c.avg_ms} ms` : ' ' },
      ]} />
      {servers.error && <ErrorNote>Couldn't load status: {errorText(servers.error)}</ErrorNote>}

      {servers.isPending ? <div className="card h-40 animate-pulse" /> : list.length === 0 ? (
        <div className="card grid justify-items-center gap-3 px-6 py-14 text-center">
          <p className="text-[16px] font-semibold">No servers yet</p>
          <p className="text-muted">Register an MCP server and its tools become available to every client through one URL.</p>
          {isAdmin && <Button variant="primary" onClick={() => setEditing('new')}><Plus size={15} />Add your first server</Button>}
        </div>
      ) : (
        <div className="grid gap-3">{list.map(s => <ServerCard key={s.id} s={s} calls={callsBy.get(s.prefix)} isAdmin={isAdmin} onEdit={() => setEditing(s)} />)}</div>
      )}

      {editing && <ServerDrawer server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ServerCard({ s, calls, isAdmin, onEdit }: { s: Server; calls?: { calls: number; errors: number }; isAdmin: boolean; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const toggle = useApiMutation((enabled: boolean) => api('PATCH', `/api/servers/${s.prefix}`, { enabled }), [['servers']]);
  const permit = useApiMutation((p: { tool: string; memberAllowed: boolean }) => api('PUT', `/api/servers/${s.prefix}/permissions`, p), [['servers']]);
  const adminOnly = s.tools.filter(t => t.memberAllowed === false).length;
  const pendingCount = s.tools.filter(t => t.pending).length;
  const [reviewing, setReviewing] = useState<Tool | null>(null);
  const dim = !s.enabled;
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
        <button onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} tools of ${s.name}`} className="rounded-full p-1 text-muted hover:bg-sidebar">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        {/* basis + min width: when space runs out the status group wraps below instead of overlapping */}
        <div className={`grid min-w-[min(100%,280px)] flex-[1_1_320px] gap-1.5 ${dim ? 'opacity-60' : ''}`}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[17px] font-semibold">{s.name}</h2>
            <span className="chip">{s.prefix}</span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
            {s.url && <span className="block max-w-full min-w-0 truncate font-mono" title={s.url}>{s.url}</span>}
            {isAdmin && <span className="flex items-center gap-1"><KeyRound size={13} />{s.authType === 'none' ? 'No auth' : `${s.authType === 'bearer' ? 'Bearer token' : `Header ${s.authHeaderName}`} · ${s.hasCredential ? 'set' : 'missing'}`}</span>}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <span className="text-[12.5px] text-muted">
            {s.tools.length} tools · {calls?.calls ?? 0} calls today{calls?.errors ? ` (${calls.errors} failed)` : ''}{s.status === 'connected' && s.latencyMs !== null ? ` · ${s.latencyMs} ms` : ''}{s.checkedAt ? ` · checked ${ago(s.checkedAt)}` : ''}
          </span>
          {pendingCount > 0 && <Pill kind="warn">{pendingCount} tool{pendingCount === 1 ? '' : 's'} to review</Pill>}
          {s.status === 'connected' && s.error ? <Pill kind="warn">Degraded</Pill> : <StatusPill status={s.status} />}
          <Toggle on={s.enabled} label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`} disabled={!isAdmin || toggle.isPending} onChange={v => toggle.mutate(v)} />
          {isAdmin && (
            <div className="relative">
              <button aria-label={`Actions for ${s.name}`} onClick={() => setMenu(!menu)} className="rounded-full p-1.5 text-muted hover:bg-sidebar"><MoreVertical size={16} /></button>
              {menu && (
                <div className="card absolute right-0 z-10 mt-1 grid w-36 p-1 text-[13px]" onMouseLeave={() => setMenu(false)}>
                  <button className="rounded-[8px] px-3 py-2 text-left hover:bg-sidebar" onClick={() => { setMenu(false); onEdit(); }}>Edit</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {s.status === 'unreachable' && s.error && (
        <div className="px-5 pb-4"><ErrorNote>{s.error}</ErrorNote></div>
      )}
      {s.status === 'connected' && s.error && (
        <div className="px-5 pb-4"><WarnNote>Last health check failed: <span className="font-mono text-[12.5px]">{s.error}</span>. Its tools stay available until it fails again.</WarnNote></div>
      )}
      {toggle.error && <div className="px-5 pb-4"><ErrorNote>{errorText(toggle.error)}</ErrorNote></div>}
      {permit.error && <div className="px-5 pb-4"><ErrorNote>{errorText(permit.error)}</ErrorNote></div>}
      {!s.enabled && !open && <p className="px-5 pb-4 text-[13px] text-muted italic">{s.tools.length} tools hidden from clients while disabled</p>}
      {open && (
        <div className="border-t border-line">
          <div className="flex items-center justify-between bg-page/60 px-5 py-2.5">
            <span className="eyebrow">{s.enabled ? 'Exposed tools' : 'Tools (hidden while disabled)'} ({s.tools.length})</span>
            <span className="eyebrow">{adminOnly ? `${adminOnly} admin-only · ` : ''}{isAdmin ? 'switch: members may use it' : `prefix: ${s.prefix}__*`}</span>
          </div>
          {s.tools.length === 0 ? <p className="px-5 py-4 text-muted">No tools seen yet.</p> : (
            <ul>{s.tools.map(t => (
              <li key={t.name} className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-5 py-3 ${!isAdmin && t.memberAllowed === false ? 'opacity-60' : ''}`}>
                <span className="chip">{t.exposedAs ?? `${s.prefix}__${t.name}`}</span>
                <span className="min-w-0 flex-1 text-[13.5px] text-ink-2">{t.description ?? ''}</span>
                {t.pending && <Pill kind="warn">Changed · hidden</Pill>}
                {t.pending && isAdmin && <Button variant="outline" className="!py-1" onClick={() => setReviewing(t)}>Review</Button>}
                {isAdmin ? (
                  <span className="flex items-center gap-2 text-[12.5px] text-muted">
                    Members
                    <Toggle on={t.memberAllowed !== false} label={`Members may use ${t.exposedAs ?? t.name}`} disabled={permit.isPending}
                      onChange={v => permit.mutate({ tool: t.name, memberAllowed: v })} />
                  </span>
                ) : t.memberAllowed === false && <Pill kind="off">Admins only</Pill>}
              </li>
            ))}</ul>
          )}
        </div>
      )}
      {reviewing && <ReviewDrawer s={s} t={reviewing} onClose={() => setReviewing(null)} />}
    </section>
  );
}

// Tool pinning: what changed since the last approval. Lines that are not in the other version are
// marked, which is enough to spot an added instruction or a new required field.
// Keys sorted, so a reordered schema (Postgres stores JSON with its own key order) shows no false changes.
const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as any)[k])])) : v;
function lines(v: unknown): string[] { return (typeof v === 'string' ? v : JSON.stringify(sortKeys(v ?? null), null, 2)).split('\n'); }
function Versions({ label, before, after }: { label: string; before: unknown; after: unknown }) {
  const a = lines(before), b = lines(after);
  if (JSON.stringify(a) === JSON.stringify(b)) return <p className="text-[13px] text-muted">{label}: unchanged</p>;
  const block = (title: string, mine: string[], other: string[], cls: string) => (
    <div className="grid gap-1">
      <span className="eyebrow">{title}</span>
      <pre className="overflow-x-auto rounded-[10px] border border-line bg-page p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap">
        {mine.map((l, i) => <div key={i} className={other.includes(l) ? '' : cls}>{l || ' '}</div>)}
      </pre>
    </div>
  );
  return (
    <div className="grid gap-2">
      <h3 className="text-[14px] font-semibold">{label}</h3>
      {block('Approved', a, b, 'bg-bad-tint text-bad')}
      {block('Now', b, a, 'bg-warn-tint text-warn-text')}
    </div>
  );
}
function ReviewDrawer({ s, t, onClose }: { s: Server; t: Tool; onClose: () => void }) {
  const approve = useApiMutation(() => api('POST', `/api/servers/${s.prefix}/tools/${encodeURIComponent(t.name)}/approve`, {}), [['servers']]);
  const now = { title: t.title ?? null, description: t.description ?? '', inputSchema: t.inputSchema ?? null };
  return (
    <Drawer title={`Review ${t.exposedAs ?? t.name}`} onClose={onClose}
      footer={<>
        <Button variant="outline" onClick={onClose}>Keep hidden</Button>
        <Button variant="primary" disabled={approve.isPending} onClick={() => approve.mutate(undefined, { onSuccess: onClose })}>Approve this version</Button>
      </>}>
      <WarnNote>
        {t.approved ? 'This tool changed since it was approved.' : 'This tool is new on a server whose tools were already approved.'} It is hidden from every client and from the chat agent until you approve it.
        Read the description as the model will: look for instructions to the model, links, or new fields that ask for data the tool should not need.
      </WarnNote>
      {t.approved ? <>
        <Versions label="Description" before={t.approved.description} after={now.description} />
        <Versions label="Title" before={t.approved.title ?? ''} after={now.title ?? ''} />
        <Versions label="Input schema" before={t.approved.inputSchema} after={now.inputSchema} />
      </> : <>
        <Versions label="Description" before="" after={now.description} />
        <Versions label="Input schema" before={null} after={now.inputSchema} />
      </>}
      {approve.error && <ErrorNote>{errorText(approve.error)}</ErrorNote>}
    </Drawer>
  );
}

function ServerDrawer({ server, onClose }: { server: Server | null; onClose: () => void }) {
  const editing = Boolean(server);
  const [prefix, setPrefix] = useState(server?.prefix ?? '');
  const [name, setName] = useState(server?.name ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [authType, setAuthType] = useState<AuthType>(server?.authType ?? 'none');
  const [headerName, setHeaderName] = useState(server?.authHeaderName ?? '');
  const [replacing, setReplacing] = useState(!server?.hasCredential);
  const [credential, setCredential] = useState('');
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const save = useApiMutation(() => {
    const body: Record<string, unknown> = { prefix, name, url, authType, enabled };
    if (authType === 'header') body.authHeaderName = headerName;
    if (authType !== 'none' && replacing) body.credential = credential;   // write-only: only sent when replaced
    return server ? api('PATCH', `/api/servers/${server.prefix}`, body) : api('POST', '/api/servers', body);
  }, [['servers']]);
  const remove = useApiMutation(() => api('DELETE', `/api/servers/${server!.prefix}`), [['servers']]);

  return (
    <Drawer title={editing ? `Edit ${server!.name}` : 'Add MCP server'} onClose={onClose} footer={<>
      <Button variant="outline" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>{save.isPending ? 'Saving…' : 'Save server'}</Button>
    </>}>
      <Field label="Prefix" htmlFor="prefix" help={<span className="font-mono">Tools appear as {prefix || 'prefix'}__&lt;tool&gt;. 2–12 lowercase letters or digits.</span>}>
        <input id="prefix" className="input font-mono" value={prefix} onChange={e => setPrefix(e.target.value.toLowerCase())} placeholder="ship" />
      </Field>
      <Field label="Name" htmlFor="name"><input id="name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Shipping" /></Field>
      <Field label="URL" htmlFor="url" help="The server's Streamable HTTP endpoint, reachable from the gateway.">
        <input id="url" className="input font-mono text-[13px]" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://platform-ship-mcp.urumi.svc.cluster.local:8080/mcp" />
      </Field>
      {editing && url !== server!.url && <WarnNote>Changing the URL reconnects this server.</WarnNote>}
      <div className="grid gap-1.5">
        <span className="label">Authentication</span>
        <div className="flex w-fit rounded-full border border-line bg-sidebar p-1" role="radiogroup">
          {(['none', 'bearer', 'header'] as const).map(t => (
            <button key={t} role="radio" aria-checked={authType === t} onClick={() => { setAuthType(t); if (server && t !== server.authType) setReplacing(true); }}
              className={`rounded-full px-3.5 py-1.5 text-[13px] ${authType === t ? 'bg-surface font-semibold shadow-[0_0_0_1px_var(--color-line)]' : 'text-ink-2'}`}>
              {{ none: 'None', bearer: 'Bearer token', header: 'Custom header' }[t]}
            </button>
          ))}
        </div>
      </div>
      {authType === 'header' && (
        <Field label="Header name" htmlFor="hname"><input id="hname" className="input font-mono" value={headerName} onChange={e => setHeaderName(e.target.value)} placeholder="X-Api-Key" /></Field>
      )}
      {authType !== 'none' && (
        <Field label={authType === 'bearer' ? 'Bearer token' : 'Header value'} htmlFor="cred" help="Stored encrypted. It is never shown again or sent to MCP clients.">
          {replacing ? (
            <input id="cred" className="input font-mono" type="password" autoComplete="off" value={credential} onChange={e => setCredential(e.target.value)} placeholder="Paste the credential" />
          ) : (
            <div className="flex items-center justify-between rounded-[10px] border border-line bg-sidebar px-3 py-2">
              <span className="font-mono text-[13px] text-muted">•••••••••••• Set</span>
              <button className="text-[13px] font-semibold text-teal hover:underline" onClick={() => setReplacing(true)}>Replace</button>
            </div>
          )}
        </Field>
      )}
      <div className="flex items-center justify-between"><span className="label">Enabled</span><Toggle on={enabled} onChange={setEnabled} label="Enabled" /></div>
      {save.error && <ErrorNote>{errorText(save.error)}</ErrorNote>}
      {editing && (
        <div className="grid gap-2 border-t border-line pt-4">
          {confirmRemove ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px]">Remove {server!.name}? Its tools disappear from every client.</span>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: onClose })}>Remove</Button>
              <Button variant="ghost" onClick={() => setConfirmRemove(false)}>Keep</Button>
            </div>
          ) : <button className="w-fit text-[13px] font-semibold text-bad hover:underline" onClick={() => setConfirmRemove(true)}>Remove server</button>}
          {remove.error && <ErrorNote>{errorText(remove.error)}</ErrorNote>}
        </div>
      )}
    </Drawer>
  );
}
