import { useState, type FormEvent } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import { api, errorText, useApiMutation, useFeatures, useGrants, useKeys, useMe } from '../api';
import { Button, CodeBox, ErrorNote, Field, Modal, PageHeader, Pill, WarnNote, ago } from '../ui';

export const gatewayUrl = () => `${location.origin}/mcp`;
export const claudeCommand = (key: string) => `claude mcp add --transport http urumi ${gatewayUrl()} --header "Authorization: Bearer ${key}"`;
// With OAuth on, the URL alone is enough: the client opens the browser for sign-in and consent.
export const claudeOAuthCommand = () => `claude mcp add --transport http urumi ${gatewayUrl()}`;

export function Keys() {
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const [showAll, setShowAll] = useState(false);
  const keys = useKeys(isAdmin && showAll);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const revoke = useApiMutation((id: string) => api('DELETE', `/api/keys/${id}`), [['keys']]);
  const oauth = useFeatures().data?.oauth === true;

  return (
    <>
      <PageHeader eyebrow="For Claude Code, Cursor and other MCP clients" title="API keys" accent="keys"
        actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus size={15} />Create key</Button>} />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="grid min-w-0 gap-3">
      {isAdmin && (
        <label className="flex w-fit items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} className="accent-teal" /> Show everyone's keys
        </label>
      )}
      {keys.data?.length === 0 ? (
        <div className="card grid justify-items-center gap-3 px-6 py-14 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-teal-tint text-teal"><KeyRound size={22} /></span>
          <p className="text-[16px] font-semibold">{showAll ? 'Nobody has an API key yet' : 'No API keys yet'}</p>
          <p className="max-w-[48ch] text-[13.5px] text-muted">A key lets Claude Code, Cursor or any MCP client use the gateway as you. Create one per device so you can revoke them separately.</p>
          <Button variant="primary" onClick={() => setCreating(true)}><Plus size={15} />Create your first key</Button>
        </div>
      ) : (
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-[13.5px]">
          <thead><tr className="eyebrow">{['Name', ...(showAll ? ['Owner'] : []), 'Key', 'Created', 'Last used', 'Status', ''].map(h => <th key={h} className="px-5 py-3 font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {keys.isPending && <tr><td colSpan={7} className="px-5 py-6 text-muted">Loading…</td></tr>}
            {keys.data?.map(k => (
              <tr key={k.id} className="border-t border-line">
                <td className="px-5 py-3 font-medium">{k.name}</td>
                {showAll && <td className="px-5 py-3 text-ink-2">{k.email}</td>}
                <td className="px-5 py-3 font-mono text-[12.5px]">{k.prefix}…</td>
                <td className="px-5 py-3 text-ink-2">{ago(k.createdAt)}</td>
                <td className="px-5 py-3 text-ink-2">{ago(k.lastUsedAt)}</td>
                <td className="px-5 py-3">{k.revokedAt ? <Pill kind="off">Revoked</Pill> : <Pill kind="ok">Active</Pill>}</td>
                <td className="px-5 py-3 text-right whitespace-nowrap">
                  {!k.revokedAt && (confirm === k.id ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="text-[12.5px] text-ink-2">Clients using it stop working.</span>
                      <Button variant="danger" className="!py-1" disabled={revoke.isPending} onClick={() => revoke.mutate(k.id, { onSuccess: () => setConfirm(null) })}>Revoke</Button>
                      <Button variant="ghost" className="!py-1" onClick={() => setConfirm(null)}>Cancel</Button>
                    </span>
                  ) : <Button variant="outline" className="!py-1" onClick={() => setConfirm(k.id)}>Revoke</Button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      {revoke.error && <ErrorNote>{errorText(revoke.error)}</ErrorNote>}
      {oauth && <ConnectedApps all={isAdmin && showAll} />}
      </section>
      <aside className="grid gap-4 xl:sticky xl:top-20">
        <section className="card grid gap-3 p-5">
          <h2 className="text-[15px] font-semibold">Connect in one line</h2>
          <p className="text-[13px] text-muted">Create a key, then add the gateway to Claude Code. Every enabled server's tools appear at once.</p>
          <CodeBox>{claudeCommand('<your key>')}</CodeBox>
          {oauth && <>
            <p className="text-[13px] text-muted">Or with no key at all: Claude Code opens your browser to sign in and approve, then appears under Connected apps.</p>
            <CodeBox>{claudeOAuthCommand()}</CodeBox>
          </>}
        </section>
        <section className="card grid gap-2 p-5 text-[13px] text-ink-2">
          <h2 className="text-[15px] font-semibold text-ink">Keep keys safe</h2>
          <ul className="grid list-disc gap-1.5 pl-4 marker:text-line-strong">
            <li>One key per device or tool, so you can revoke just one.</li>
            <li>Keys are shown once and stored only as a hash. Lost a key? Create a new one.</li>
            <li>Revoking takes effect on the very next request.</li>
            <li>Every call made with a key is in the audit log under your name.</li>
          </ul>
        </section>
      </aside>
      </div>
      {creating && <CreateKey onClose={() => setCreating(false)} onCreated={k => { setCreating(false); setCreated(k); }} />}
      {created && (
        <Modal title="Your new API key" onClose={() => setCreated(null)}>
          <CodeBox>{created.key}</CodeBox>
          <WarnNote>Copy it now. For your safety it won't be shown again.</WarnNote>
          <div className="grid gap-2"><span className="eyebrow">Connect Claude Code</span><CodeBox>{claudeCommand(created.key)}</CodeBox></div>
          <div className="flex justify-end"><Button variant="ink" onClick={() => setCreated(null)}>Done</Button></div>
        </Modal>
      )}
    </>
  );
}

function CreateKey({ onClose, onCreated }: { onClose: () => void; onCreated: (k: { key: string; name: string }) => void }) {
  const [name, setName] = useState('');
  const create = useApiMutation((n: string) => api<{ key: string; name: string }>('POST', '/api/keys', { name: n }), [['keys']]);
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(name, { onSuccess: onCreated }); };
  return (
    <Modal title="Create API key" onClose={onClose} width="max-w-[440px]">
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Name" htmlFor="kname" help="Where you'll use it, e.g. laptop or claude-code."><input id="kname" autoFocus className="input" required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></Field>
        {create.error && <ErrorNote>{errorText(create.error)}</ErrorNote>}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={create.isPending}>Create key</Button></div>
      </form>
    </Modal>
  );
}

// Apps connected with OAuth (a browser sign-in instead of a key). Disconnecting revokes the grant:
// its tokens stop working on the next request.
function ConnectedApps({ all }: { all: boolean }) {
  const grants = useGrants(true, all);
  const [confirm, setConfirm] = useState<string | null>(null);
  const revoke = useApiMutation((id: string) => api('DELETE', `/api/oauth/grants/${id}`), [['grants']]);
  return (
    <section className="grid gap-2">
      <h2 className="text-[15px] font-semibold">Connected apps</h2>
      {grants.data?.length === 0 ? (
        <p className="text-[13px] text-muted">No apps connected with a browser sign-in.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-[13.5px]">
            <thead><tr className="eyebrow">{['App', ...(all ? ['Owner'] : []), 'Connected', 'Last used', ''].map(h => <th key={h} className="px-5 py-3 font-normal">{h}</th>)}</tr></thead>
            <tbody>
              {grants.data?.map(g => (
                <tr key={g.id} className="border-t border-line">
                  <td className="px-5 py-3 font-medium">{g.client}</td>
                  {all && <td className="px-5 py-3 text-ink-2">{g.email}</td>}
                  <td className="px-5 py-3 text-ink-2">{ago(g.createdAt)}</td>
                  <td className="px-5 py-3 text-ink-2">{ago(g.lastUsedAt)}</td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    {confirm === g.id ? (
                      <span className="inline-flex items-center gap-2">
                        <Button variant="danger" className="!py-1" disabled={revoke.isPending} onClick={() => revoke.mutate(g.id, { onSuccess: () => setConfirm(null) })}>Disconnect</Button>
                        <Button variant="ghost" className="!py-1" onClick={() => setConfirm(null)}>Cancel</Button>
                      </span>
                    ) : <Button variant="outline" className="!py-1" onClick={() => setConfirm(g.id)}>Disconnect</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {revoke.error && <ErrorNote>{errorText(revoke.error)}</ErrorNote>}
    </section>
  );
}

