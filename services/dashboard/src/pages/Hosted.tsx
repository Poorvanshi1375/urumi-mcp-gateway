import { useState } from 'react';
import { Link } from 'react-router';
import { Plus, Trash2, RotateCcw, Box } from 'lucide-react';
import { api, errorText, useApiMutation, useHosted, type Hosted } from '../api';
import { Button, Drawer, ErrorNote, Field, PageHeader, Pill, StatusPill, Toggle, WarnNote, ago } from '../ui';

// Hosted MCP servers (stand-out 5): an admin gives a container image; the provisioner runs it in its
// own namespace with its own Secret, limits and network policy, registers it, and removes it cleanly.
export function HostedServers() {
  const q = useHosted();
  const [adding, setAdding] = useState(false);
  const list = q.data?.servers ?? [];
  return (
    <>
      <PageHeader eyebrow={`Gateway · ${list.length} of ${q.data?.maxServers ?? '…'} hosted`} title="Hosted servers" accent="servers"
        actions={<Button variant="primary" onClick={() => setAdding(true)} disabled={!q.data || list.length >= q.data.maxServers}><Plus size={15} />Host a server</Button>} />
      <p className="max-w-[78ch] text-[14px] text-muted">
        Give a container image that serves MCP over HTTP. The platform runs it in its own namespace with its own Secret, resource limits and network policy
        (it can be reached only by the gateway and reaches nothing unless you allow the internet), registers it as a server, and removes everything when you delete it.
        Its tools then appear on <Link to="/servers" className="text-teal hover:underline">Servers</Link> under its prefix, pinned and admin-only until you allow them.
      </p>
      {q.error && <ErrorNote>{errorText(q.error)}</ErrorNote>}
      {q.data && !list.length && <div className="card p-8 text-center text-muted">No hosted servers yet.</div>}
      <div className="grid gap-4">{list.map(h => <HostedCard key={h.id} h={h} />)}</div>
      {adding && q.data && <AddHosted allowed={q.data.allowedImages} onClose={() => setAdding(false)} />}
    </>
  );
}

const stateLabel: Record<Hosted['state'], ['ok' | 'warn' | 'bad' | 'off', string]> = {
  provisioning: ['warn', 'Provisioning'], ready: ['ok', 'Ready'], failed: ['bad', 'Failed'], deleting: ['off', 'Deleting'],
};

function HostedCard({ h }: { h: Hosted }) {
  const [confirm, setConfirm] = useState(false);
  const del = useApiMutation(() => api('DELETE', `/api/hosted/${h.id}`), [['hosted'], ['servers']]);
  const retry = useApiMutation(() => api('POST', `/api/hosted/${h.id}/retry`, {}), [['hosted']]);
  const [kind, label] = stateLabel[h.state];
  return (
    <section className="card grid gap-3 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Box size={18} className="text-muted" />
        <h2 className="text-[17px] font-semibold">{h.name}</h2>
        <span className="chip">{h.prefix}</span>
        <Pill kind={kind}>{label}{h.state === 'provisioning' && h.step ? ` · ${h.step}` : ''}</Pill>
        {h.server && <StatusPill status={h.server.status} />}
        <span className="ml-auto flex gap-2">
          {h.state === 'failed' && <Button disabled={retry.isPending} onClick={() => retry.mutate(undefined)}><RotateCcw size={14} />Retry</Button>}
          {h.state !== 'deleting' && (confirm
            ? <><Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(undefined)}>Delete {h.prefix}</Button><Button variant="ghost" onClick={() => setConfirm(false)}>Keep</Button></>
            : <Button variant="outline" onClick={() => setConfirm(true)}><Trash2 size={14} />Delete</Button>)}
        </span>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-muted">Image</dt><dd className="font-mono">{h.image}</dd>
        <dt className="text-muted">Namespace</dt><dd className="font-mono">{h.namespace}</dd>
        <dt className="text-muted">Address</dt><dd className="font-mono break-all">{h.url}</dd>
        <dt className="text-muted">Size</dt><dd>{h.size}{h.needsInternet ? ' · internet allowed' : ' · no internet'}</dd>
        {Object.keys(h.env).length > 0 && <><dt className="text-muted">Env</dt><dd className="font-mono">{Object.keys(h.env).join(', ')}</dd></>}
        {h.secretEnvKeys.length > 0 && <><dt className="text-muted">Secret env</dt><dd className="font-mono">{h.secretEnvKeys.join(', ')} <span className="text-muted">(values never shown)</span></dd></>}
        <dt className="text-muted">Created</dt><dd>{ago(h.createdAt)}{h.readyAt ? ` · ready ${ago(h.readyAt)}` : ''}{h.server ? ` · ${h.server.tools} tools` : ''}</dd>
      </dl>
      {h.error && (h.state === 'failed' ? <ErrorNote>{h.error}</ErrorNote> : <WarnNote>Retrying: {h.error}</WarnNote>)}
      {confirm && <p className="text-[12.5px] text-muted">Deleting removes its tools from every client at once, then its namespace and everything in it.</p>}
    </section>
  );
}

type EnvRow = { k: string; v: string };
function EnvRows({ rows, setRows, secret }: { rows: EnvRow[]; setRows: (r: EnvRow[]) => void; secret?: boolean }) {
  return (
    <div className="grid gap-2">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <input className="input w-[40%] font-mono text-[13px]" placeholder="NAME" value={r.k} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, k: e.target.value.toUpperCase() } : x))} />
          <input className="input flex-1 font-mono text-[13px]" placeholder="value" type={secret ? 'password' : 'text'} autoComplete="off" value={r.v} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
          <Button variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove">×</Button>
        </div>
      ))}
      <Button variant="ghost" className="w-fit" onClick={() => setRows([...rows, { k: '', v: '' }])}><Plus size={14} />Add</Button>
    </div>
  );
}

function AddHosted({ allowed, onClose }: { allowed: string[]; onClose: () => void }) {
  const [prefix, setPrefix] = useState(''), [name, setName] = useState(''), [image, setImage] = useState('');
  const [port, setPort] = useState('8080'), [path, setPath] = useState('/mcp'), [size, setSize] = useState<'small' | 'medium' | 'large'>('small');
  const [internet, setInternet] = useState(false), [env, setEnv] = useState<EnvRow[]>([]), [secretEnv, setSecretEnv] = useState<EnvRow[]>([]);
  const toMap = (rows: EnvRow[]) => Object.fromEntries(rows.filter(r => r.k.trim()).map(r => [r.k.trim(), r.v]));
  const save = useApiMutation(() => api('POST', '/api/hosted', { prefix, name, image, port: Number(port), path, size, needsInternet: internet, env: toMap(env), secretEnv: toMap(secretEnv) }), [['hosted']]);
  return (
    <Drawer title="Host an MCP server" onClose={onClose} footer={<>
      <Button variant="outline" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>{save.isPending ? 'Starting…' : 'Host it'}</Button>
    </>}>
      <Field label="Prefix" htmlFor="h-prefix" help={<span className="font-mono">Tools appear as {prefix || 'prefix'}__&lt;tool&gt;; namespace mcp-{prefix || 'prefix'}. 2–12 lowercase letters or digits.</span>}>
        <input id="h-prefix" className="input font-mono" value={prefix} onChange={e => setPrefix(e.target.value.toLowerCase())} placeholder="ship2" />
      </Field>
      <Field label="Name" htmlFor="h-name"><input id="h-name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Shipping (hosted)" /></Field>
      <Field label="Image" htmlFor="h-image" help={<>With a version tag or digest (not :latest). Allowed: <span className="font-mono">{allowed.join(', ') || 'none'}</span></>}>
        <input id="h-image" className="input font-mono text-[13px]" value={image} onChange={e => setImage(e.target.value)} placeholder="urumi-ship-mcp:1.0.0" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Port" htmlFor="h-port"><input id="h-port" className="input font-mono" inputMode="numeric" value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="Path" htmlFor="h-path"><input id="h-path" className="input font-mono" value={path} onChange={e => setPath(e.target.value)} /></Field>
      </div>
      <Field label="Size" help="CPU and memory: small 100m/128Mi, medium 250m/256Mi, large 500m/512Mi.">
        <select className="input" value={size} onChange={e => setSize(e.target.value as typeof size)}>
          <option value="small">small</option><option value="medium">medium</option><option value="large">large</option>
        </select>
      </Field>
      <Field label="Environment"><EnvRows rows={env} setRows={setEnv} /></Field>
      <Field label="Secret environment" help="Stored encrypted and put in the server's own Secret; never shown again."><EnvRows rows={secretEnv} setRows={setSecretEnv} secret /></Field>
      <div className="flex items-center justify-between"><span className="label">Needs internet (public 80/443)</span><Toggle on={internet} onChange={setInternet} label="Needs internet" /></div>
      {save.error && <ErrorNote>{errorText(save.error)}</ErrorNote>}
    </Drawer>
  );
}
