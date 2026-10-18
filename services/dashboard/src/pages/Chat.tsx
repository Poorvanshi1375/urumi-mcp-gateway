import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronDown, ChevronRight, Loader2, RotateCcw, Square } from 'lucide-react';
import { api, usableTools, useMe, useServers } from '../api';
import { Markdown } from '../markdown';
import { Button, ErrorNote, PageHeader, Pill } from '../ui';

type ToolStep = { id: string; name: string; args: unknown; running: boolean; outcome?: string; durationMs?: number; preview?: string; isError?: boolean };
type Msg = { role: 'user'; text: string } | { role: 'assistant'; text: string; tools: ToolStep[]; error?: string; done: boolean };
type Event =
  | { type: 'model'; model: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  | { type: 'tool_end'; id: string; name: string; outcome: string; durationMs: number; preview: string; isError: boolean }
  | { type: 'text'; text: string } | { type: 'done'; steps: number } | { type: 'error'; message: string };

// adminOnly: needs a tool members cannot use by default (create_product, update_order_status).
const SUGGESTIONS = [
  { text: 'What orders came in today?' },
  { text: 'Create a product called Urumi Tote Bag for ₹799', adminOnly: true },
  { text: 'Where is the shipment for order 16?' },
  { text: 'Quote shipping to 560001 for a 1.2 kg parcel' },
];
const MORE = [
  { text: 'Create a product called Monsoon Mug for ₹349 and show it to me', adminOnly: true },
  { text: 'Mark order 17 as completed', adminOnly: true },
  { text: 'Which orders are still processing, and where are their shipments?' },
  { text: 'List the products that cost less than ₹500' },
  { text: 'How does the MCP TypeScript SDK handle sessions? (DeepWiki)' },
];

// The conversation survives page switches within the session (per signed-in user).
const storeKey = (uid: string) => `urumi-chat:${uid}`;
const load = (uid: string): Msg[] => { try { return JSON.parse(sessionStorage.getItem(storeKey(uid)) ?? '[]'); } catch { return []; } };
const save = (uid: string, msgs: Msg[]) => { try { sessionStorage.setItem(storeKey(uid), JSON.stringify(msgs)); } catch { /* storage unavailable */ } };

export function Chat() {
  const me = useMe();
  const uid = me.data!.id;
  const servers = useServers();
  const status = useQuery({ queryKey: ['chat-status'], queryFn: () => api<{ enabled: boolean; model: string | null; tools: number }>('GET', '/api/chat/status') });
  const qc = useQueryClient();
  const [msgs, setMsgs] = useState<Msg[]>(() => load(uid));
  const [input, setInput] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const busy = msgs.at(-1)?.role === 'assistant' && !(msgs.at(-1) as Extract<Msg, { role: 'assistant' }>).done;

  useEffect(() => { save(uid, msgs); bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs, uid]);

  const update = (fn: (a: Extract<Msg, { role: 'assistant' }>) => void) =>
    setMsgs(prev => { const next = [...prev]; const last = { ...(next.at(-1) as Extract<Msg, { role: 'assistant' }>) }; last.tools = [...last.tools]; fn(last); next[next.length - 1] = last; return next; });

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const history = [...msgs.filter(m => m.role === 'user' || (m.role === 'assistant' && m.done && !m.error && m.text)).map(m => ({ role: m.role, text: m.text })), { role: 'user' as const, text: question }];
    setMsgs(prev => [...prev, { role: 'user', text: question }, { role: 'assistant', text: '', tools: [], done: false }]);
    setInput('');
    const ac = new AbortController(); abort.current = ac;
    try {
      const res = await fetch('/api/chat', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: history.slice(-40) }), signal: ac.signal });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `Chat failed (${res.status})`);
      }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (!chunk.startsWith('data: ')) continue;
          const e = JSON.parse(chunk.slice(6)) as Event;
          if (e.type === 'model') setModel(e.model);
          else if (e.type === 'tool_start') update(a => { a.tools.push({ id: e.id, name: e.name, args: e.args, running: true }); });
          else if (e.type === 'tool_end') update(a => { a.tools = a.tools.map(t => t.id === e.id ? { ...t, running: false, outcome: e.outcome, durationMs: e.durationMs, preview: e.preview, isError: e.isError } : t); });
          else if (e.type === 'text') update(a => { a.text = e.text; });
          else if (e.type === 'error') update(a => { a.error = e.message; });
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') update(a => { a.error = 'Stopped.'; });
      else update(a => { a.error = (e as Error).message; });
    } finally {
      update(a => { a.done = true; a.tools = a.tools.map(t => t.running ? { ...t, running: false, outcome: 'stopped' } : t); });
      abort.current = null;
      void qc.invalidateQueries({ queryKey: ['overview'] });
    }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void send(input); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } };

  const isAdmin = me.data?.role === 'admin';
  const live = (servers.data ?? []).filter(s => s.enabled && s.status === 'connected');
  const toolCount = live.reduce((n, s) => n + usableTools(s, me.data?.role).length, 0);
  const suggestions = SUGGESTIONS.filter(s => isAdmin || !s.adminOnly), more = MORE.filter(s => isAdmin || !s.adminOnly).slice(0, 4);

  return (
    <>
      <PageHeader eyebrow={`Agent · ${model ?? status.data?.model ?? 'Gemini'} · ${toolCount} tools from ${live.length} servers`} title="Ask your store" accent="store"
        actions={msgs.length > 0 && <Button variant="outline" disabled={busy} onClick={() => { setMsgs([]); save(uid, []); }}><RotateCcw size={14} />New chat</Button>} />
      {status.data && !status.data.enabled && <ErrorNote>Chat is not configured: the platform has no Gemini API key. An admin can add it as the platform-llm secret.</ErrorNote>}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="card flex min-h-[calc(100vh-260px)] min-w-0 flex-col">
          <div className="flex-1 overflow-y-auto px-6 py-6">
            {msgs.length === 0 ? (
              <div className="grid h-full content-center justify-items-center gap-4 py-10 text-center">
                <p className="text-[20px] font-semibold tracking-[-0.01em]">What would you like to know?</p>
                <p className="max-w-[54ch] text-[14px] text-muted">The agent answers with live data from your store, shipping and docs. It acts as you, and every tool it calls is in the audit log.</p>
                <div className="flex max-w-[640px] flex-wrap justify-center gap-2 pt-2">
                  {suggestions.map(({ text: s }) => <button key={s} onClick={() => void send(s)} className="rounded-full border border-line bg-page px-3.5 py-1.5 text-[13px] hover:bg-sidebar">{s}</button>)}
                </div>
              </div>
            ) : (
              <div className="mx-auto grid max-w-[820px] gap-6">
                {msgs.map((m, i) => m.role === 'user'
                  ? <div key={i} className="max-w-[80%] justify-self-end rounded-[18px] rounded-br-[6px] bg-teal-tint px-4 py-2.5 text-[14px] whitespace-pre-wrap">{m.text}</div>
                  : <AssistantTurn key={i} m={m} />)}
                <div ref={bottom} />
              </div>
            )}
          </div>
          <form onSubmit={submit} className="border-t border-line p-4">
            <div className="mx-auto flex max-w-[820px] items-end gap-2 rounded-[22px] border border-line bg-page p-2 pl-4 focus-within:border-teal">
              <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKey} rows={1} maxLength={8000}
                placeholder="Ask about products, orders, shipping or docs…" aria-label="Message"
                className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent py-1.5 text-[14px] placeholder:text-muted focus:outline-none [field-sizing:content]" />
              {busy
                ? <button type="button" onClick={() => abort.current?.abort()} aria-label="Stop" className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-page hover:bg-ink-2"><Square size={14} fill="currentColor" /></button>
                : <button type="submit" disabled={!input.trim() || status.data?.enabled === false} aria-label="Send" className="grid size-9 shrink-0 place-items-center rounded-full bg-teal text-on-teal hover:bg-teal-hover disabled:opacity-40"><ArrowUp size={17} /></button>}
            </div>
            <p className="mx-auto mt-2 max-w-[820px] text-center text-[12px] text-muted">Acting as {me.data!.email} · every tool call is audited</p>
          </form>
        </section>

        <aside className="grid gap-4 xl:sticky xl:top-20">
          <section className="card grid gap-3 p-5">
            <div className="flex items-baseline justify-between"><h2 className="text-[15px] font-semibold">Tools the agent can use</h2><span className="font-mono text-[12px] text-muted">{toolCount}</span></div>
            {live.length === 0 ? <p className="text-[13px] text-muted">No servers are connected right now.</p> : live.map(s => (
              <div key={s.id} className="grid gap-1.5">
                <span className="flex items-center gap-2 text-[13px] font-semibold"><span className="size-1.5 rounded-full bg-ok" />{s.name}</span>
                <div className="flex flex-wrap gap-1">{usableTools(s, me.data?.role).map(t => <span key={t.name} className="chip !text-[11px]">{t.exposedAs ?? `${s.prefix}__${t.name}`}</span>)}</div>
              </div>
            ))}
            {!isAdmin && live.some(s => usableTools(s, me.data?.role).length < s.tools.length) && (
              <p className="text-[12.5px] text-muted">Some tools are for admins only, so the agent does not offer them to you.</p>
            )}
            {(servers.data ?? []).filter(s => !s.enabled || s.status !== 'connected').map(s => (
              <p key={s.id} className="text-[12.5px] text-muted">{s.name}: {s.enabled ? 'unreachable' : 'disabled'}, so its tools are hidden from the agent.</p>
            ))}
          </section>
          <section className="card grid gap-2 p-5">
            <h2 className="text-[15px] font-semibold">Try asking</h2>
            {more.map(({ text: s }) => <button key={s} disabled={busy} onClick={() => void send(s)} className="rounded-[10px] px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-sidebar disabled:opacity-50">{s}</button>)}
          </section>
        </aside>
      </div>
    </>
  );
}

function AssistantTurn({ m }: { m: Extract<Msg, { role: 'assistant' }> }) {
  return (
    <div className="grid gap-3">
      {m.tools.length > 0 && <div className="grid gap-2">{m.tools.map(t => <ToolCard key={t.id} t={t} />)}</div>}
      {m.text && <Markdown text={m.text} />}
      {!m.done && !m.text && (
        <span className="flex items-center gap-2 text-[13px] text-muted"><Loader2 size={14} className="animate-spin" />{m.tools.some(t => t.running) ? 'Calling tools…' : m.tools.length ? 'Writing the answer…' : 'Thinking…'}</span>
      )}
      {m.error && <ErrorNote>{m.error}</ErrorNote>}
    </div>
  );
}

function ToolCard({ t }: { t: ToolStep }) {
  const [open, setOpen] = useState(false);
  const i = t.name.indexOf('__');
  const [server, tool] = i > 0 ? [t.name.slice(0, i), t.name.slice(i + 2)] : ['', t.name];
  const pretty = (v: string) => { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } };
  return (
    <div className="rounded-[12px] border border-line bg-page/60">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left">
        {open ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
        {server && <span className="chip !py-0 !text-[11px]">{server}</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{tool}</span>
        {t.running ? <Pill kind="warn"><Loader2 size={11} className="animate-spin" />running</Pill>
          : t.outcome === 'ok' ? <Pill kind="ok">ok · {t.durationMs} ms</Pill>
          : <Pill kind={t.outcome === 'tool_error' || t.outcome === 'timeout' ? 'warn' : 'bad'}>{(t.outcome ?? 'error').replace('_', ' ')}{t.durationMs !== undefined ? ` · ${t.durationMs} ms` : ''}</Pill>}
      </button>
      {open && (
        <div className="grid gap-2 border-t border-line px-3.5 py-3">
          <span className="eyebrow">Arguments</span>
          <pre className="overflow-x-auto rounded-[8px] bg-sidebar p-2.5 font-mono text-[12px]">{JSON.stringify(t.args, null, 2)}</pre>
          {t.preview !== undefined && <>
            <span className="eyebrow">Result{t.preview.length >= 600 ? ' (first 600 characters)' : ''}</span>
            <pre className={`max-h-64 overflow-auto rounded-[8px] bg-sidebar p-2.5 font-mono text-[12px] whitespace-pre-wrap ${t.isError ? 'text-bad' : ''}`}>{pretty(t.preview)}</pre>
          </>}
        </div>
      )}
    </div>
  );
}
