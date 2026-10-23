import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Box, KeyRound, Store, LogOut, MessageSquare, PlugZap, ScrollText, Server, Users } from 'lucide-react';
import { api, ApiError, usableTools, useFeatures, useMe, useServers, type User } from './api';
import { Avatar } from './ui';

export const Mark = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <rect width="32" height="32" rx="9" fill="var(--color-teal)" />
    <path d="M10 9v9a6 6 0 0 0 12 0V9" fill="none" stroke="var(--color-on-teal)" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

// Navigation grouped by what people come to do.
const sections = [
  { label: 'Workspace', items: [
    { to: '/chat', label: 'Chat', icon: MessageSquare },
    { to: '/stores', label: 'Stores', icon: Store, admin: true, feature: 'stores' as const },
  ] },
  { label: 'Gateway', items: [
    { to: '/servers', label: 'Servers', icon: Server },
    { to: '/hosted', label: 'Hosted servers', icon: Box, admin: true, feature: 'provisioner' as const },
    { to: '/audit', label: 'Audit log', icon: ScrollText },
    { to: '/connect', label: 'Connect', icon: PlugZap },
  ] },
  { label: 'Access', items: [
    { to: '/keys', label: 'API keys', icon: KeyRound },
    { to: '/users', label: 'People', icon: Users, admin: true },
  ] },
];
const crumbs: Record<string, [string, string]> = {
  '/chat': ['Workspace', 'Chat'], '/stores': ['Workspace', 'Stores'], '/servers': ['Gateway', 'Servers'], '/audit': ['Gateway', 'Audit log'],
  '/connect': ['Gateway', 'Connect'], '/hosted': ['Gateway', 'Hosted servers'], '/keys': ['Access', 'API keys'], '/users': ['Access', 'People'],
};

// Signed-in layout. Anything under it requires a session; 401 sends you to /login.
export function Shell() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <div className="grid h-full place-items-center text-muted">Loading…</div>;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    return <div className="grid h-full place-items-center text-bad">Couldn't reach the gateway: {me.error.message}</div>;
  }
  return (
    <div className="grid h-full grid-cols-[248px_1fr] max-md:grid-cols-1 max-md:grid-rows-[auto_1fr]">
      <Sidebar user={me.data} />
      <main className="flex min-w-0 flex-col overflow-y-auto">
        <TopBar path={location.pathname} />
        <div className="mx-auto grid w-full max-w-[1440px] gap-6 px-10 pt-7 pb-12 max-lg:px-6 max-md:px-4"><Outlet /></div>
      </main>
    </div>
  );
}

// Slim bar: where you are, and whether the gateway is healthy right now.
function TopBar({ path }: { path: string }) {
  const servers = useServers();
  const me = useMe();
  const list = servers.data ?? [];
  const enabled = list.filter(s => s.enabled);
  const up = enabled.filter(s => s.status === 'connected');
  const tools = up.reduce((n, s) => n + usableTools(s, me.data?.role).length, 0);
  const healthy = enabled.length > 0 && up.length === enabled.length;
  const [group, page] = crumbs[path] ?? ['', ''];
  return (
    <div className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-line bg-page/90 px-10 py-3 backdrop-blur max-lg:px-6 max-md:px-4">
      <div className="flex items-center gap-2 font-mono text-[12px] tracking-[0.08em] uppercase">
        <span className="text-muted">{group}</span><span className="text-line-strong">/</span><span className="text-ink">{page}</span>
      </div>
      {servers.data && (
        <Link to="/servers" className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] hover:bg-sidebar">
          <span className={`size-2 rounded-full ${healthy ? 'bg-ok' : up.length ? 'bg-warn' : 'bg-bad'}`} aria-hidden />
          <span className="font-medium">{up.length}/{enabled.length} servers up</span>
          <span className="text-muted">· {tools} tools live</span>
        </Link>
      )}
    </div>
  );
}

function Sidebar({ user }: { user: User }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = async () => { await api('POST', '/api/auth/logout', {}).catch(() => {}); qc.clear(); navigate('/login'); };
  const features = useFeatures().data;
  return (
    <aside className="flex min-w-0 flex-col gap-6 border-r border-line bg-sidebar px-4 py-5 max-md:gap-3 max-md:border-r-0 max-md:border-b">
      <div className="flex items-center gap-2.5 px-2"><Mark /><span className="text-[16px] font-semibold tracking-[-0.01em]">Urumi Gateway</span></div>
      <nav className="grid gap-5 max-md:flex max-md:flex-wrap max-md:gap-1">
        {sections.map(sec => {
          const items = sec.items.filter(n => (!('admin' in n && n.admin) || user.role === 'admin') && (!('feature' in n) || Boolean(features?.[(n as { feature: 'provisioner' | 'stores' }).feature])));
          if (!items.length) return null;
          return (
            <div key={sec.label} className="grid gap-0.5 max-md:flex max-md:flex-wrap">
              <span className="eyebrow px-4 pb-1.5 text-[10.5px] max-md:hidden">{sec.label}</span>
              {items.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-full px-4 py-2 text-[14px] ${isActive ? 'bg-raised font-semibold text-ink' : 'text-ink-2 hover:bg-raised/60'}`}>
                  <Icon size={16} strokeWidth={1.8} />{label}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="mt-auto grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 max-md:hidden">
        <div className="flex items-center justify-between rounded-[10px] border border-line bg-surface px-3 py-2 font-mono text-[12px] text-muted">
          {location.host}<span className="size-1.5 rounded-full bg-ok" aria-label="online" />
        </div>
        <div className="flex items-center gap-2.5 rounded-[12px] border border-line bg-surface p-2.5">
          <Avatar name={user.name} email={user.email} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5"><span className="truncate text-[13px] font-semibold">{user.name ?? user.email.split('@')[0]}</span>
              <span className="rounded-full bg-teal-tint px-1.5 font-mono text-[10.5px] text-teal capitalize">{user.role}</span></div>
            <div className="truncate text-[12px] text-muted">{user.email}</div>
          </div>
          <button onClick={logout} aria-label="Sign out" title="Sign out" className="rounded-full p-1.5 text-muted hover:bg-sidebar hover:text-ink"><LogOut size={16} /></button>
        </div>
      </div>
    </aside>
  );
}

export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (me.data?.role !== 'admin') return <Navigate to="/servers" replace />;
  return <>{children}</>;
}
