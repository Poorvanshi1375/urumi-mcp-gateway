import { useState } from 'react';
import { Link } from 'react-router';
import { useServers } from '../api';
import { CodeBox, PageHeader } from '../ui';
import { gatewayUrl } from './Keys';

const clients = {
  'Claude Code': () => `claude mcp add --transport http urumi ${gatewayUrl()} --header "Authorization: Bearer <your key>"`,
  Cursor: () => JSON.stringify({ mcpServers: { urumi: { url: gatewayUrl(), headers: { Authorization: 'Bearer <your key>' } } } }, null, 2),
  'MCP Inspector': () => `npx @modelcontextprotocol/inspector\n# Transport: Streamable HTTP · URL: ${gatewayUrl()}\n# Header: Authorization = Bearer <your key>`,
};

export function Connect() {
  const [tab, setTab] = useState<keyof typeof clients>('Claude Code');
  const servers = useServers();
  const live = (servers.data ?? []).filter(s => s.enabled && s.status === 'connected');
  return (
    <>
      <PageHeader eyebrow="One URL · one key · every enabled server" title="Connect a client" accent="client" />
      <div className="grid items-start gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="grid gap-5">
          <section className="card grid gap-3 p-5">
            <h2 className="text-[15px] font-semibold">Gateway URL</h2>
            <CodeBox>{gatewayUrl()}</CodeBox>
            <p className="text-[13px] text-muted">Use an API key from the <Link to="/keys" className="font-semibold text-teal hover:underline">API keys</Link> page as a Bearer token.</p>
          </section>
          <section className="card grid gap-3 p-5">
            <div className="flex flex-wrap gap-1.5" role="tablist">
              {(Object.keys(clients) as (keyof typeof clients)[]).map(c => (
                <button key={c} role="tab" aria-selected={tab === c} onClick={() => setTab(c)}
                  className={`rounded-full px-3.5 py-1.5 text-[13px] ${tab === c ? 'bg-raised font-semibold' : 'text-ink-2 hover:bg-sidebar'}`}>{c}</button>
              ))}
            </div>
            <CodeBox>{clients[tab]()}</CodeBox>
          </section>
        </div>
        <div className="grid gap-5">
          <section className="card grid gap-2 p-5">
            <h2 className="text-[15px] font-semibold">How tool names work</h2>
            <p className="text-[13.5px] text-ink-2">Each server has a prefix. Tools appear as <span className="font-mono text-[12.5px]">&lt;prefix&gt;__&lt;tool&gt;</span>, so these two can coexist:</p>
            <div className="flex flex-wrap gap-1.5"><span className="chip">woo__get_order</span><span className="chip">ship__get_order</span></div>
          </section>
          <section className="card grid gap-2 p-5">
            <span className="eyebrow">Exposed right now · {live.reduce((n, s) => n + s.tools.length, 0)} tools</span>
            <div className="flex flex-wrap gap-1.5">{live.map(s => <span key={s.id} className="chip">{s.prefix} ({s.tools.length})</span>)}</div>
          </section>
        </div>
      </div>
    </>
  );
}
