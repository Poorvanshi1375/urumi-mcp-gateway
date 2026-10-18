// The gateway core: the one place that decides which tools a caller sees and what happens when a
// tool is called. The external /mcp endpoint and the chat agent both go through it, so
// permissions, timeouts and audit cannot differ between them.
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import type { Tool } from '@modelcontextprotocol/client';
import type { Db } from '../db/client.ts';
import { recordAudit } from '../services/audit.ts';
import { toolCallSeconds, toolCalls } from '../lib/metrics.ts';
import type { Permissions } from '../services/permissions.ts';
import type { Principal } from './auth.ts';
import { SEPARATOR, type CallResult, type UpstreamManager } from './upstream-manager.ts';

type Logger = { error: (o: object, m: string) => void };
export type Source = 'mcp' | 'chat';

export function createGatewayCore(deps: { db: Db; manager: UpstreamManager; perms: Permissions; log: Logger }) {
  const { db, manager, perms, log } = deps;

  // Tools this caller may use: enabled, connected, and allowed for their role. Hidden tools are
  // not listed at all.
  function listToolsFor(principal: Principal | undefined): Tool[] {
    return manager.listTools((prefix, tool) => perms.allows(principal?.role, prefix, tool));
  }

  // Route one call (timeouts, disabled and unreachable checks live in the manager), refuse it if
  // the caller's role may not use the tool, and audit it under the caller either way (T3).
  async function callAsUser(principal: Principal | undefined, source: Source, name: string, args: Record<string, unknown> | undefined)
    : Promise<CallResult & { durationMs: number }> {
    const t0 = Date.now();
    const target = manager.resolve(name);
    const r: CallResult = target && !perms.allows(principal?.role, target.upstream.prefix, target.tool)
      ? {
        result: { content: [{ type: 'text', text: `Tool "${name}" is not available to your role (${principal?.role ?? 'unknown'}). Ask an admin if you need it.` }], isError: true },
        outcome: 'denied', upstream: target.upstream, tool: target.tool, error: `not allowed for role ${principal?.role ?? 'unknown'}`,
      }
      : await manager.callTool(name, args);
    const durationMs = Date.now() - t0;
    const i = name.indexOf(SEPARATOR);
    await recordAudit(db, {
      userId: principal?.userId,
      apiKeyId: principal?.apiKeyId,
      keyPrefix: principal?.keyPrefix,
      source,
      upstreamId: r.upstream?.id,
      serverPrefix: r.upstream?.prefix ?? (i > 0 ? name.slice(0, i) : null),
      tool: r.tool ?? (i > 0 ? name.slice(i + SEPARATOR.length) : name),
      durationMs,
      outcome: r.outcome,
      error: r.error,
    }).catch(e => log.error({ err: String(e) }, 'audit write failed'));
    const server = r.upstream?.prefix ?? 'unknown';
    toolCalls.inc({ server, tool: r.tool ?? (i > 0 ? name.slice(i + SEPARATOR.length) : name), outcome: r.outcome, source });
    toolCallSeconds.observe({ server, outcome: r.outcome }, durationMs / 1000);
    return { ...r, durationMs };
  }

  // Tool search mode (behind platform.features.toolSearch): for clients that would otherwise get
  // hundreds of tools. Ranks the caller's own tools (same permissions and pinning as listToolsFor)
  // by how often the query's words appear in the name (weight 3) and description (weight 1).
  function searchTools(principal: Principal | undefined, query: string, limit = 10) {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
    return listToolsFor(principal)
      .map(t => {
        const name = t.name.toLowerCase(), desc = (t.description ?? '').toLowerCase();
        return { t, score: words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (desc.includes(w) ? 1 : 0), 0) };
      })
      .filter(x => x.score > 0 || !words.length)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(limit, 1), 25))
      .map(({ t }) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  return { listToolsFor, callAsUser, searchTools };
}
export type GatewayCore = ReturnType<typeof createGatewayCore>;

// The two tools a client sees in search mode. "gateway" is a reserved prefix.
export const SEARCH_TOOL = `gateway${SEPARATOR}search_tools`;
export const CALL_TOOL = `gateway${SEPARATOR}call_tool`;
const searchModeTools: Tool[] = [
  {
    name: SEARCH_TOOL,
    description: 'Find tools available to you through the gateway. Returns matching tool names, descriptions and input schemas. Search first, then call a tool with gateway__call_tool.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words describing what you want to do, e.g. "orders today" or "shipment tracking"' }, limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 } }, required: ['query'] },
  },
  {
    name: CALL_TOOL,
    description: 'Call a tool found with gateway__search_tools, by its exact name, with arguments matching its input schema.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] },
  },
];
const textResult = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError } : {}) });

// The gateway's own MCP server: one endpoint, a fresh low-level Server per request (stateless).
export function createGatewayHandler(core: GatewayCore, opts: { toolSearch: boolean } = { toolSearch: false }) {
  return createMcpHandler(({ authInfo }) => {
    const principal = authInfo?.extra?.principal as Principal | undefined;
    const source = (authInfo?.extra?.source as Source | undefined) ?? 'mcp';
    const searchMode = opts.toolSearch && authInfo?.extra?.mode === 'search';
    const server = new Server(
      { name: 'urumi-gateway', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } }, instructions: searchMode
        ? `Search mode: find tools with ${SEARCH_TOOL}, then call them with ${CALL_TOOL}.`
        : `Tools from several MCP servers, named <server>${SEPARATOR}<tool>.` },
    );
    server.setRequestHandler('tools/list', async () => ({ tools: searchMode ? searchModeTools : core.listToolsFor(principal) }));
    server.setRequestHandler('tools/call', async request => {
      const { name, arguments: args } = request.params;
      if (searchMode && name === SEARCH_TOOL) {
        const query = typeof args?.query === 'string' ? args.query : '';
        const hits = core.searchTools(principal, query, Number(args?.limit ?? 10));
        return textResult({ query, count: hits.length, tools: hits });
      }
      if (searchMode && name === CALL_TOOL) {
        if (typeof args?.name !== 'string') return textResult('gateway__call_tool needs "name": the exact tool name from gateway__search_tools', true);
        // The same routed, permission-checked and audited path as a direct call.
        return (await core.callAsUser(principal, source, args.name, (args.arguments ?? {}) as Record<string, unknown>)).result;
      }
      return (await core.callAsUser(principal, source, name, args)).result;
    });
    return server;
  });
}
