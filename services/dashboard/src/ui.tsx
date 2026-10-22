// Small House-styled building blocks shared by every page.
import { useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import type { Outcome, ServerStatus } from './api';

type Variant = 'primary' | 'ink' | 'outline' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-teal text-on-teal hover:bg-teal-hover',
  ink: 'bg-ink text-page hover:bg-ink-2',
  outline: 'border border-line bg-surface text-ink hover:bg-sidebar',
  danger: 'border border-bad text-bad hover:bg-bad-tint',
  ghost: 'text-ink-2 hover:bg-sidebar',
};
const buttonBase = 'inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';
export function Button({ variant = 'outline', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button {...rest} className={`${buttonBase} ${variants[variant]} ${className}`} />;
}
// A link styled as a button (downloads, navigation that must stay a real link).
export function ButtonLink({ variant = 'outline', className = '', ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant }) {
  return <a {...rest} className={`${buttonBase} ${variants[variant]} ${className}`} />;
}

const tone = {
  ok: 'bg-ok-tint text-ok-text [--dot:var(--color-ok)]',
  bad: 'bg-bad-tint text-bad [--dot:var(--color-bad)]',
  warn: 'bg-warn-tint text-warn-text [--dot:var(--color-warn)]',
  off: 'bg-off-tint text-off-text [--dot:var(--color-off)]',
};
export function Pill({ kind, children }: { kind: keyof typeof tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pr-2.5 pl-2 font-mono text-[12px] font-medium ${tone[kind]}`}>
      <span className="size-1.5 rounded-full bg-(--dot)" aria-hidden />{children}
    </span>
  );
}
const statusPill: Record<ServerStatus, [keyof typeof tone, string]> = {
  connected: ['ok', 'Connected'], unreachable: ['bad', 'Unreachable'], disabled: ['off', 'Disabled'], unknown: ['warn', 'Checking'],
};
export const StatusPill = ({ status }: { status: ServerStatus }) => <Pill kind={statusPill[status][0]}>{statusPill[status][1]}</Pill>;
const outcomePill: Record<Outcome, [keyof typeof tone, string]> = {
  ok: ['ok', 'ok'], tool_error: ['warn', 'tool error'], timeout: ['warn', 'timeout'], upstream_unreachable: ['bad', 'unreachable'], rejected: ['bad', 'rejected'], denied: ['bad', 'denied'],
  busy: ['warn', 'busy'], pending: ['off', 'in progress'], unknown: ['bad', 'no result'],
};
export const OutcomePill = ({ outcome }: { outcome: Outcome }) => <Pill kind={outcomePill[outcome][0]}>{outcomePill[outcome][1]}</Pill>;

// Page title with one italic teal word, as on urumi.ai.
export function PageHeader({ eyebrow, title, accent, actions }: { eyebrow: string; title: string; accent: string; actions?: ReactNode }) {
  const i = title.lastIndexOf(accent);
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="grid gap-1">
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em]">
          {i >= 0 ? <>{title.slice(0, i)}<em className="font-medium text-teal">{accent}</em>{title.slice(i + accent.length)}</> : title}
        </h1>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? 'bg-teal' : 'bg-off'}`}>
      <span className={`absolute top-0.5 size-4 rounded-full bg-surface transition-[left] ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

// The clipboard API exists only in secure contexts (HTTPS or http://localhost). On any other plain
// HTTP address it is missing, so fall back to the older copy command, and if that fails too, ask
// for Ctrl+C (the text is select-all). A key shown once must never fail to copy silently.
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* not a secure context */ }
  const area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.appendChild(area); area.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'manual'>('idle');
  return (
    <Button variant="outline" className="!px-3 !py-1" onClick={async () => {
      const ok = await copyText(text);
      setState(ok ? 'done' : 'manual');
      setTimeout(() => setState('idle'), ok ? 1500 : 4000);
    }}>{state === 'done' ? <Check size={14} /> : <Copy size={14} />}{state === 'done' ? 'Copied' : state === 'manual' ? 'Select and press Ctrl+C' : label}</Button>
  );
}

export const CodeBox = ({ children, copy }: { children: string; copy?: boolean }) => (
  <div className="flex items-start gap-2 rounded-[10px] border border-line bg-sidebar p-3">
    <code className="min-w-0 flex-1 font-mono text-[12.5px] whitespace-pre-wrap select-all [overflow-wrap:anywhere]">{children}</code>
    {copy !== false && <CopyButton text={children} />}
  </div>
);

export const ErrorNote = ({ children }: { children: ReactNode }) =>
  <div role="alert" className="rounded-[10px] border border-bad/30 bg-bad-tint px-3 py-2 font-mono text-[12.5px] text-bad">{children}</div>;
export const WarnNote = ({ children }: { children: ReactNode }) =>
  <div className="rounded-[10px] bg-warn-tint px-3 py-2 text-[13px] text-warn-text">{children}</div>;

export function Modal({ title, onClose, children, width = 'max-w-[560px]' }: { title: string; onClose: () => void; children: ReactNode; width?: string }) {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30 p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal aria-label={title} className={`card grid w-full gap-4 p-6 ${width}`}>
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[18px] font-semibold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="rounded-full p-1 text-muted hover:bg-sidebar"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/25" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-modal aria-label={title} className="flex h-full w-full max-w-[480px] flex-col border-l border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-[18px] font-semibold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="rounded-full p-1 text-muted hover:bg-sidebar"><X size={18} /></button>
        </div>
        <div className="grid flex-1 content-start gap-5 overflow-y-auto px-6 py-5">{children}</div>
        <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>
      </aside>
    </div>
  );
}

export const Field = ({ label, help, children, htmlFor }: { label: string; help?: ReactNode; children: ReactNode; htmlFor?: string }) => (
  <label className="grid gap-1.5" htmlFor={htmlFor}><span className="label">{label}</span>{children}{help && <span className="help">{help}</span>}</label>
);

export const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.max(s, 0)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
export const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour12: false });
export const initials = (u: { name: string | null; email: string }) =>
  (u.name ?? u.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(p => p[0]!.toUpperCase()).join('');

// A row of key numbers, separated by hairlines (Urumi style: mono label, figure, hint).
export type Stat = { label: string; value: ReactNode; hint?: ReactNode; tone?: 'bad' | 'warn' | 'ok' };
export function SummaryStrip({ stats }: { stats: Stat[] }) {
  const toneCls = { bad: 'text-bad', warn: 'text-warn-text', ok: 'text-ok-text' };
  return (
    <div className="card grid grid-cols-2 overflow-hidden sm:grid-cols-3 lg:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
      {stats.map(s => (
        <div key={s.label} className="grid content-start gap-1 border-line px-5 py-4 [&:not(:first-child)]:border-l max-lg:border-t max-lg:[&:not(:first-child)]:border-l-0">
          <span className="eyebrow">{s.label}</span>
          <span className={`text-[24px] leading-tight font-semibold tracking-[-0.02em] tabular-nums ${s.tone ? toneCls[s.tone] : ''}`}>{s.value}</span>
          {s.hint && <span className="text-[12.5px] text-muted">{s.hint}</span>}
        </div>
      ))}
    </div>
  );
}

export function Avatar({ name, email, size = 34 }: { name: string | null; email: string; size?: number }) {
  // Stable warm tint per person, from the House neutrals and teal tint (no rainbow avatars).
  const tints = ['bg-teal-tint text-teal', 'bg-raised text-ink', 'bg-warn-tint text-warn-text', 'bg-ok-tint text-ok-text', 'bg-sidebar text-ink-2'];
  const i = [...email].reduce((n, c) => n + c.charCodeAt(0), 0) % tints.length;
  return <span style={{ width: size, height: size }} className={`grid shrink-0 place-items-center rounded-full text-[12.5px] font-semibold ${tints[i]}`}>{initials({ name, email })}</span>;
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; count?: number }[] }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line">
      {items.map(t => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={`-mb-px flex items-center gap-2 border-b-2 px-3 pb-2.5 text-[14px] ${value === t.id ? 'border-teal font-semibold text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}>
          {t.label}{t.count !== undefined && <span className={`rounded-full px-1.5 font-mono text-[11px] ${value === t.id ? 'bg-teal-tint text-teal' : 'bg-sidebar text-muted'}`}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 focus-within:border-teal sm:max-w-[320px]">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13.5px] placeholder:text-muted focus:outline-none" />
    </label>
  );
}

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
