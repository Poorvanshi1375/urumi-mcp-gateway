import { useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText, type User } from '../api';
import { Mark } from '../Shell';
import { Button, ErrorNote, Field } from '../ui';

const Card = ({ children }: { children: ReactNode }) => (
  <div className="grid min-h-full place-items-center px-4 py-10">
    <div className="card grid w-full max-w-[400px] gap-5 p-7">
      <div className="flex items-center gap-2.5"><Mark /><span className="text-[16px] font-semibold">Urumi Gateway</span></div>
      {children}
    </div>
  </div>
);

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/chat';
  const qc = useQueryClient();
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const { user } = await api<{ user: User }>('POST', '/api/auth/login', { email, password });
      qc.setQueryData(['me'], user);
      navigate(from === '/login' ? '/chat' : from, { replace: true });
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <Card>
      <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Sign in</h1>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Email" htmlFor="email"><input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Password" htmlFor="password"><input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
      <p className="text-[12.5px] text-muted">Accounts are by invitation. Ask an admin for an invite.</p>
    </Card>
  );
}

export function AcceptInvite() {
  const { token = '' } = useParams();
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => api<{ email: string; role: string; expiresAt: string }>('GET', `/api/invites/${encodeURIComponent(token)}`), retry: false });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (password !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    try {
      const { user } = await api<{ user: User }>('POST', '/api/invites/accept', { token, name: name || undefined, password });
      qc.setQueryData(['me'], user);
      navigate('/chat', { replace: true });
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <Card>
      <div className="grid gap-1">
        <span className="eyebrow">Invitation</span>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Join <em className="font-medium text-teal">Urumi</em> Gateway</h1>
      </div>
      {invite.isPending && <p className="text-muted">Checking your invite…</p>}
      {invite.error && <ErrorNote>This invite link is not valid. It may have been used already or expired. Ask an admin for a new one.</ErrorNote>}
      {invite.data && (
        <>
          <p className="text-[14px]">You're invited as <b className="capitalize">{invite.data.role}</b> · <span className="font-mono text-[13px]">{invite.data.email}</span></p>
          <form onSubmit={submit} className="grid gap-4">
            <Field label="Name" htmlFor="name"><input id="name" className="input" autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></Field>
            <Field label="Password" htmlFor="pw" help="At least 10 characters"><input id="pw" className="input" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={e => setPassword(e.target.value)} /></Field>
            <Field label="Confirm password" htmlFor="pw2"><input id="pw2" className="input" type="password" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} /></Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</Button>
          </form>
        </>
      )}
    </Card>
  );
}
