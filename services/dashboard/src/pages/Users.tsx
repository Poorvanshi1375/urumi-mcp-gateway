import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, Minus, UserPlus } from 'lucide-react';
import { api, errorText, useApiMutation, useInvites, useMe, useOverview, useUsers, type Invite, type Role, type User } from '../api';
import { Avatar, Button, CodeBox, ErrorNote, Field, PageHeader, Pill, SearchInput, SummaryStrip, Tabs, ago, shortDate } from '../ui';

type Filter = 'all' | 'admin' | 'member' | 'disabled';

export function Users() {
  const me = useMe();
  const users = useUsers();
  const invites = useInvites();
  const overview = useOverview();
  const [tab, setTab] = useState<'people' | 'invites'>('people');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const inviteEmail = useRef<HTMLInputElement>(null);

  const people = users.data ?? [];
  const activity = useMemo(() => new Map((overview.data?.perUser ?? []).map(u => [u.id, u])), [overview.data]);
  const pending = (invites.data ?? []).filter(i => i.status === 'pending');
  const p = overview.data?.people;
  const shown = people.filter(u =>
    (filter === 'all' || (filter === 'disabled' ? !!u.disabledAt : u.role === filter && !u.disabledAt)) &&
    (!q || `${u.name ?? ''} ${u.email}`.toLowerCase().includes(q.toLowerCase())));
  const counts: Record<Filter, number> = {
    all: people.length, admin: people.filter(u => u.role === 'admin' && !u.disabledAt).length,
    member: people.filter(u => u.role === 'member' && !u.disabledAt).length, disabled: people.filter(u => u.disabledAt).length,
  };

  return (
    <>
      <PageHeader eyebrow={`Access · ${counts.all - counts.disabled} active people`} title="People and access" accent="access"
        actions={<Button variant="primary" onClick={() => inviteEmail.current?.focus()}><UserPlus size={15} />Invite someone</Button>} />

      <SummaryStrip stats={[
        { label: 'Active people', value: p?.active ?? '—', hint: p ? `${p.admins} admin${p.admins === 1 ? '' : 's'} · ${p.active - p.admins} member${p.active - p.admins === 1 ? '' : 's'}` : ' ' },
        { label: 'Pending invites', value: p?.pending_invites ?? '—', hint: 'Single-use, 7 days' },
        { label: 'Active API keys', value: p?.active_keys ?? '—', hint: 'Across everyone' },
        { label: 'Tool calls · 24 h', value: overview.data?.calls.calls ?? '—', hint: overview.data ? `${overview.data.calls.rejected} rejected` : ' ' },
        { label: 'Disabled', value: p?.disabled ?? '—', hint: 'Their keys stop working' },
      ]} />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="grid min-w-0 gap-4">
          <Tabs value={tab} onChange={setTab} items={[{ id: 'people', label: 'People', count: people.length }, { id: 'invites', label: 'Invites', count: pending.length }]} />
          {tab === 'people' ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <SearchInput value={q} onChange={setQ} placeholder="Search by name or email" />
                <div className="flex flex-wrap gap-1">
                  {(['all', 'admin', 'member', 'disabled'] as const).map(f => (
                    <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
                      className={`rounded-full px-3 py-1.5 text-[13px] ${filter === f ? 'bg-ink text-page' : 'border border-line bg-surface text-ink-2 hover:bg-sidebar'}`}>
                      {{ all: 'All', admin: 'Admins', member: 'Members', disabled: 'Disabled' }[f]} <span className="font-mono text-[11px] opacity-70">{counts[f]}</span>
                    </button>
                  ))}
                </div>
              </div>
              <PeopleTable people={shown} meId={me.data?.id} activity={activity} />
            </>
          ) : <InvitesTable invites={invites.data ?? []} />}
        </section>

        <aside className="grid gap-4 xl:sticky xl:top-20">
          <InviteCard inputRef={inviteEmail} onCreated={() => setTab('invites')} />
          <RolesCard />
        </aside>
      </div>
    </>
  );
}

function PeopleTable({ people, meId, activity }: { people: User[]; meId?: string; activity: Map<string, { active_keys: number; last_active: string | null; calls_24h: number }> }) {
  const update = useApiMutation(({ id, ...body }: { id: string; role?: Role; disabled?: boolean }) => api('PATCH', `/api/users/${id}`, body), [['users']]);
  return (
    <div className="grid gap-2">
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-[13.5px]">
          <thead>
            <tr className="eyebrow border-b border-line">
              {['Person', 'Role', 'Activity · 24 h', 'Status', ''].map(h =>
                <th key={h} className="px-4 py-3 font-normal whitespace-nowrap first:pl-5">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {people.length === 0 && <tr><td colSpan={5} className="px-5 py-10 text-center text-muted">Nobody matches this search.</td></tr>}
            {people.map(u => {
              const self = u.id === meId;
              const a = activity.get(u.id);
              return (
                <tr key={u.id} className={`border-t border-line first:border-t-0 hover:bg-page/60 ${u.disabledAt ? 'text-muted' : ''}`}>
                  <td className="py-3 pr-4 pl-5">
                    <div className="flex min-w-[260px] items-center gap-3">
                      <span className={u.disabledAt ? 'opacity-50' : ''}><Avatar name={u.name} email={u.email} /></span>
                      <div className="grid min-w-0">
                        <span className="flex items-center gap-1.5 truncate font-semibold text-ink">
                          {u.name ?? u.email.split('@')[0]}{self && <span className="rounded-full bg-sidebar px-1.5 font-mono text-[10.5px] font-normal text-muted">you</span>}
                        </span>
                        <span className="truncate text-[12.5px] text-muted">{u.email} · joined {shortDate(u.createdAt)}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <select aria-label={`Role of ${u.email}`} value={u.role} disabled={update.isPending || self}
                      onChange={e => update.mutate({ id: u.id, role: e.target.value as Role })}
                      className="rounded-full border border-line bg-surface py-1 pr-2 pl-3 text-[13px] disabled:opacity-60">
                      <option value="admin">Admin</option><option value="member">Member</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-ink-2">
                    {a ? (
                      <div className="grid">
                        <span><span className="font-mono text-[12.5px] text-ink tabular-nums">{a.calls_24h}</span> calls · <span className="font-mono text-[12.5px] text-ink tabular-nums">{a.active_keys}</span> {a.active_keys === 1 ? 'key' : 'keys'}</span>
                        <span className="text-[12.5px] text-muted">active {ago(a.last_active)}</span>
                      </div>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3">{u.disabledAt ? <Pill kind="off">Disabled</Pill> : <Pill kind="ok">Active</Pill>}</td>
                  <td className="py-3 pr-5 pl-4 text-right">
                    {!self && <Button variant={u.disabledAt ? 'outline' : 'ghost'} className="!px-3 !py-1" disabled={update.isPending}
                      onClick={() => update.mutate({ id: u.id, disabled: !u.disabledAt })}>{u.disabledAt ? 'Enable' : 'Disable'}</Button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {update.error && <ErrorNote>{errorText(update.error)}</ErrorNote>}
    </div>
  );
}

function InvitesTable({ invites }: { invites: Invite[] }) {
  const cancel = useApiMutation((id: string) => api('DELETE', `/api/invites/${id}`), [['invites']]);
  if (invites.length === 0) return (
    <div className="card grid justify-items-center gap-1.5 px-6 py-12 text-center">
      <p className="font-semibold">No invites yet</p>
      <p className="max-w-[46ch] text-[13.5px] text-muted">Invite a teammate with the form on the right. They get a one-time link to set their password.</p>
    </div>
  );
  const kind = { pending: 'warn', accepted: 'ok', expired: 'off' } as const;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-left text-[13.5px]">
        <thead><tr className="eyebrow border-b border-line">{['Email', 'Role', 'Sent', 'Expires', 'Status', ''].map(h => <th key={h} className="px-4 py-3 font-normal first:pl-5">{h}</th>)}</tr></thead>
        <tbody>
          {invites.map(i => (
            <tr key={i.id} className="border-t border-line first:border-t-0">
              <td className="py-3 pr-4 pl-5 font-medium">{i.email}</td>
              <td className="px-4 py-3 capitalize">{i.role}</td>
              <td className="px-4 py-3 text-ink-2">{ago(i.createdAt)}</td>
              <td className="px-4 py-3 text-ink-2">{i.status === 'pending' ? shortDate(i.expiresAt) : '—'}</td>
              <td className="px-4 py-3"><Pill kind={kind[i.status]}>{i.status}</Pill></td>
              <td className="py-3 pr-5 pl-4 text-right">
                {i.status === 'pending' && <button className="text-[13px] font-semibold text-bad hover:underline" onClick={() => cancel.mutate(i.id)}>Cancel</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const roleInfo: Record<Role, string> = {
  member: 'Uses chat, manages their own API keys, sees server status and their own audit trail.',
  admin: 'Everything a member can do, plus servers, people, invites and the full audit log.',
};

function InviteCard({ inputRef, onCreated }: { inputRef: React.RefObject<HTMLInputElement | null>; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [link, setLink] = useState<{ url: string; email: string } | null>(null);
  const create = useApiMutation((b: { email: string; role: Role }) => api<{ acceptPath: string }>('POST', '/api/invites', b), [['invites']]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ email, role }, { onSuccess: r => { setLink({ url: `${location.origin}${r.acceptPath}`, email }); setEmail(''); onCreated(); } });
  };
  return (
    <form onSubmit={submit} className="card grid gap-4 p-5">
      <div className="grid gap-0.5">
        <h2 className="text-[16px] font-semibold">Invite someone</h2>
        <p className="text-[13px] text-muted">They'll get a one-time link to join.</p>
      </div>
      <Field label="Email" htmlFor="iemail"><input ref={inputRef} id="iemail" className="input" type="email" required placeholder="name@company.com" value={email} onChange={e => setEmail(e.target.value)} /></Field>
      <div className="grid gap-2">
        <span className="label">Role</span>
        <div className="grid gap-2" role="radiogroup" aria-label="Role">
          {(['member', 'admin'] as const).map(r => (
            <button type="button" key={r} role="radio" aria-checked={role === r} onClick={() => setRole(r)}
              className={`grid gap-0.5 rounded-[12px] border px-3.5 py-2.5 text-left ${role === r ? 'border-teal bg-teal-tint/60' : 'border-line bg-surface hover:bg-sidebar'}`}>
              <span className="flex items-center gap-2 text-[13.5px] font-semibold capitalize">
                <span className={`grid size-4 place-items-center rounded-full border ${role === r ? 'border-teal bg-teal' : 'border-line-strong'}`}>{role === r && <span className="size-1.5 rounded-full bg-on-teal" />}</span>{r}
              </span>
              <span className="pl-6 text-[12.5px] text-muted">{roleInfo[r]}</span>
            </button>
          ))}
        </div>
      </div>
      <Button variant="primary" type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create invite link'}</Button>
      {create.error && <ErrorNote>{errorText(create.error)}</ErrorNote>}
      {link && (
        <div className="grid gap-1.5 border-t border-line pt-4">
          <span className="eyebrow">Link for {link.email}</span>
          <CodeBox>{link.url}</CodeBox>
          <span className="help">Shown once · single use · expires in 7 days</span>
        </div>
      )}
    </form>
  );
}

function RolesCard() {
  const rows: [string, boolean, boolean][] = [
    ['Chat with the agent', true, true], ['Create and revoke own API keys', true, true], ['See server status and tools', true, true],
    ['See own audit trail', true, true], ['Add, edit, disable servers', false, true], ['Invite people, change roles', false, true], ['See everyone\'s audit log', false, true],
  ];
  const mark = (v: boolean) => v ? <Check size={15} className="mx-auto text-ok" aria-label="yes" /> : <Minus size={15} className="mx-auto text-line-strong" aria-label="no" />;
  return (
    <section className="card grid gap-3 p-5">
      <h2 className="text-[15px] font-semibold">What each role can do</h2>
      <table className="w-full text-[13px]">
        <thead><tr className="eyebrow"><th className="pb-2 text-left font-normal" /><th className="w-16 pb-2 font-normal">Member</th><th className="w-16 pb-2 font-normal">Admin</th></tr></thead>
        <tbody>{rows.map(([label, m, a]) => <tr key={label} className="border-t border-line"><td className="py-2 pr-2 text-ink-2">{label}</td><td>{mark(m)}</td><td>{mark(a)}</td></tr>)}</tbody>
      </table>
    </section>
  );
}
