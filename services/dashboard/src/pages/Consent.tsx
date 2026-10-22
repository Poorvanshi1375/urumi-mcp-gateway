import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api, errorText, type User } from '../api';
import { Mark } from '../Shell';
import { Button, ErrorNote } from '../ui';

// OAuth consent (stand-out 3). GET /oauth/authorize checks the request and sends the browser here;
// the server checks it again on approve. Signed out: sign in first, then come back.
type Req = { client: string; redirectHost: string; user: User; resource: string } | { redirect: string };

export function Consent() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const params = Object.fromEntries(new URLSearchParams(search));
  const req = useQuery({ queryKey: ['oauth-request', search], queryFn: () => api<Req>('GET', `/api/oauth/request${search}`), retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (req.error instanceof ApiError && req.error.status === 401) navigate('/login', { replace: true, state: { from: `/oauth/consent${search}` } });
    if (req.data && 'redirect' in req.data) window.location.assign(req.data.redirect);
  }, [req.error, req.data, navigate, search]);

  async function decide(allow: boolean) {
    setBusy(true); setError(null);
    try {
      const r = await api<{ redirect: string }>('POST', allow ? '/api/oauth/approve' : '/api/oauth/deny', params);
      window.location.assign(r.redirect);
    } catch (e) { setError(errorText(e)); setBusy(false); }
  }

  const d = req.data && 'client' in req.data ? req.data : null;
  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <div className="card grid w-full max-w-[440px] gap-5 p-7">
        <div className="flex items-center gap-2.5"><Mark /><span className="text-[16px] font-semibold">Urumi Gateway</span></div>
        {req.isPending && <p className="text-muted">Checking the request…</p>}
        {req.error && !(req.error instanceof ApiError && req.error.status === 401) && <ErrorNote>{errorText(req.error)}</ErrorNote>}
        {d && <>
          <div className="grid gap-1">
            <span className="eyebrow">Connect an app</span>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Allow <em className="font-medium text-teal">{d.client}</em> to use the gateway as you?</h1>
          </div>
          <ul className="grid list-disc gap-1.5 pl-4 text-[13.5px] text-ink-2 marker:text-line-strong">
            <li>Signed in as <b>{d.user.name ?? d.user.email}</b> ({d.user.email}, {d.user.role}).</li>
            <li>It can list and call the same tools you can, nothing more. Every call is in the audit log under your name.</li>
            <li>It gets a token for <span className="font-mono text-[12.5px]">{d.resource}</span> only, and you can disconnect it any time on the API keys page.</li>
            <li>After you choose, your browser returns to <span className="font-mono text-[12.5px]">{d.redirectHost}</span>.</li>
          </ul>
          <p className="text-[12.5px] text-muted">The app's name is what it says about itself. Allow it only if you just started connecting it.</p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={() => decide(false)}>Deny</Button>
            <Button variant="primary" disabled={busy} onClick={() => decide(true)}>Allow</Button>
          </div>
        </>}
      </div>
    </div>
  );
}
