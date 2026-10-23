import { useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Plus, RotateCcw, Store as StoreIcon, Trash2 } from 'lucide-react';
import { api, errorText, useApiMutation, useStores, type Store } from '../api';
import { Button, CodeBox, Drawer, ErrorNote, Field, PageHeader, Pill, StatusPill, WarnNote, ago } from '../ui';

// Bonus stores (multi-store): each is a WooCommerce store in its own namespace, with its own
// database, Secret and address, and its own MCP server, registered as <name>.
export function Stores() {
  const q = useStores();
  const [adding, setAdding] = useState(false);
  const list = q.data?.stores ?? [];
  return (
    <>
      <PageHeader eyebrow={`Workspace · ${list.length} of ${q.data?.max ?? '…'} extra stores`} title="Stores" accent="Stores"
        actions={<Button variant="primary" onClick={() => setAdding(true)} disabled={!q.data || list.length >= q.data.max}><Plus size={15} />Create store</Button>} />
      <p className="max-w-[78ch] text-[14px] text-muted">
        Each store gets its own namespace with its own MySQL, WordPress, generated passwords and address, and its own MCP server: its tools appear as
        <span className="font-mono"> &lt;name&gt;__list_orders</span> and so on, for chat and every MCP client. Deleting a store removes its tools at once, then everything it had, including its data.
      </p>
      {q.error && <ErrorNote>{errorText(q.error)}</ErrorNote>}
      <section className="card flex flex-wrap items-center gap-3 p-5 opacity-80">
        <StoreIcon size={18} className="text-muted" />
        <h2 className="text-[16px] font-semibold">Default store</h2>
        <span className="chip">woo</span>
        <Pill kind="off">Built in</Pill>
        <span className="text-[13px] text-muted">Installed with the platform; its tools are <Link to="/servers" className="text-teal hover:underline">woo__*</Link>. It cannot be deleted here.</span>
      </section>
      <div className="grid gap-4">{list.map(s => <StoreCard key={s.id} s={s} />)}</div>
      {adding && q.data && <AddStore data={q.data} onClose={() => setAdding(false)} />}
    </>
  );
}

const stateLabel: Record<Store['state'], ['ok' | 'warn' | 'bad' | 'off', string]> = {
  provisioning: ['warn', 'Provisioning'], ready: ['ok', 'Ready'], failed: ['bad', 'Failed'], deleting: ['off', 'Deleting'],
};

function StoreCard({ s }: { s: Store }) {
  const [confirm, setConfirm] = useState(''), [asking, setAsking] = useState(false);
  const del = useApiMutation(() => api('DELETE', `/api/stores/${s.id}?confirm=${encodeURIComponent(confirm)}`), [['stores'], ['servers']]);
  const retry = useApiMutation(() => api('POST', `/api/stores/${s.id}/retry`, {}), [['stores']]);
  const [kind, label] = stateLabel[s.state];
  const elapsed = Math.round((Date.now() - new Date(s.createdAt).getTime()) / 1000);
  return (
    <section className="card grid gap-3 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <StoreIcon size={18} className="text-muted" />
        <h2 className="text-[17px] font-semibold">{s.title}</h2>
        <span className="chip">{s.slug}</span>
        <Pill kind={kind}>{label}{s.state === 'provisioning' ? ` · ${s.step ?? 'starting'} · ${elapsed} s` : ''}</Pill>
        {s.server && <StatusPill status={s.server.status} />}
        <span className="ml-auto flex gap-2">
          {s.state === 'failed' && <Button disabled={retry.isPending} onClick={() => retry.mutate(undefined)}><RotateCcw size={14} />Retry</Button>}
          {s.state !== 'deleting' && !asking && <Button variant="outline" onClick={() => setAsking(true)}><Trash2 size={14} />Delete</Button>}
        </span>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-muted">Store</dt><dd>{s.state === 'ready' ? <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-teal hover:underline">{s.url}<ExternalLink size={12} /></a> : <span className="font-mono">{s.url}</span>}</dd>
        <dt className="text-muted">Admin</dt><dd>{s.state === 'ready' ? <a href={s.adminUrl} target="_blank" rel="noreferrer" className="text-teal hover:underline">{s.adminUrl}</a> : <span className="font-mono">{s.adminUrl}</span>} <span className="text-muted">· user {s.adminUser}</span></dd>
        <dt className="text-muted">Tools</dt><dd className="font-mono">{s.slug}__*{s.server ? ` (${s.server.tools})` : ''}</dd>
        <dt className="text-muted">Settings</dt><dd>{s.currency} · {s.country} · {s.timezone}</dd>
        <dt className="text-muted">Created</dt><dd>{ago(s.createdAt)}{s.readyAt ? ` · ready ${ago(s.readyAt)}` : ''}</dd>
      </dl>
      {s.state === 'ready' && <details className="text-[13px]"><summary className="cursor-pointer text-muted">Admin password (stays in the cluster; read it with kubectl)</summary><div className="mt-2"><CodeBox copy>{s.adminPasswordCommand}</CodeBox></div></details>}
      {s.error && (s.state === 'failed' ? <ErrorNote>{s.error}</ErrorNote> : <WarnNote>Retrying: {s.error}</WarnNote>)}
      {asking && (
        <div className="grid gap-2 rounded-[10px] border border-bad/30 bg-bad-tint/30 p-3">
          <span className="text-[13px]">This deletes <b>{s.title}</b> and all its data (orders, products, customers). Type <span className="font-mono">{s.slug}</span> to confirm.</span>
          <div className="flex gap-2">
            <input className="input w-48 font-mono" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={s.slug} />
            <Button variant="danger" disabled={confirm !== s.slug || del.isPending} onClick={() => del.mutate(undefined)}>Delete store</Button>
            <Button variant="ghost" onClick={() => { setAsking(false); setConfirm(''); }}>Keep</Button>
          </div>
          {del.error && <ErrorNote>{errorText(del.error)}</ErrorNote>}
        </div>
      )}
    </section>
  );
}

function AddStore({ data, onClose }: { data: { baseHost: string; currencies: string[]; countries: Record<string, string>; timezones: string[] }; onClose: () => void }) {
  const [slug, setSlug] = useState(''), [title, setTitle] = useState('');
  const [currency, setCurrency] = useState(data.currencies[0]), [country, setCountry] = useState(Object.keys(data.countries)[0]), [timezone, setTimezone] = useState(data.timezones[0]);
  const save = useApiMutation(() => api('POST', '/api/stores', { slug, title, currency, country, timezone }), [['stores']]);
  return (
    <Drawer title="Create a store" onClose={onClose} footer={<>
      <Button variant="outline" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>{save.isPending ? 'Starting…' : 'Create store'}</Button>
    </>}>
      <Field label="Name" htmlFor="s-slug" help={<span className="font-mono">{slug || 'name'}.{data.baseHost}; tools {slug || 'name'}__*. 2–12 lowercase letters or digits.</span>}>
        <input id="s-slug" className="input font-mono" value={slug} onChange={e => setSlug(e.target.value.toLowerCase())} placeholder="nyc" />
      </Field>
      <Field label="Title" htmlFor="s-title"><input id="s-title" className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="New York Store" /></Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Currency"><select className="input" value={currency} onChange={e => setCurrency(e.target.value)}>{data.currencies.map(c => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Country"><select className="input" value={country} onChange={e => setCountry(e.target.value)}>{Object.entries(data.countries).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Timezone"><select className="input" value={timezone} onChange={e => setTimezone(e.target.value)}>{data.timezones.map(t => <option key={t}>{t}</option>)}</select></Field>
      </div>
      <p className="text-[12.5px] text-muted">Takes about two minutes: a database, WordPress, WooCommerce with sample products, and the store's MCP server.</p>
      {save.error && <ErrorNote>{errorText(save.error)}</ErrorNote>}
    </Drawer>
  );
}
