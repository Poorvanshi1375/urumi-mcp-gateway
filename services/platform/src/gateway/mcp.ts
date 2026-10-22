// The gateway core: the one place that decides which tools a caller sees and what happens when a
// tool is called. The external /mcp endpoint and the chat agent both go through it, so
// permissions, timeouts and audit cannot differ between them.
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import type { Tool } from '@modelcontextprotocol/client';
import type { Db } from '../db/client.ts';
import { createHash, randomBytes } from 'node:crypto';
import { beginAudit, finishAudit } from '../services/audit.ts';
import { stable } from '../services/pins.ts';
import { auditUnavailable, toolCallSeconds, toolCalls } from '../lib/metrics.ts';
import { asksInChat, type Permissions } from '../services/permissions.ts';
import type { Principal } from './auth.ts';
import { SEPARATOR, type CallResult, type UpstreamManager } from './upstream-manager.ts';

type Logger = { error: (o: object, m: string) => void };
export type Source = 'mcp' | 'chat';

export function createGatewayCore(deps: { db: Db; manager: UpstreamManager; perms: Permissions; log: Logger }) {
  const { db, manager, perms, log } = deps;

  // Tools this caller may use: enabled, connected, and allowed for their role. Hidden tools are
  // not listed at all.
  function listToolsFor(principal: Principal | undefined): Tool[] {
    return manager.listTools((prefix, tool, t) => perms.allows(principal?.role, prefix, tool, manager.readOnly(prefix, t)));
  }

  // Route one call (timeouts, disabled and unreachable checks live in the manager), refuse it if
  // the caller's role may not use the tool, and audit it under the caller either way (T3). The audit
  // row is written first ("pending"): if that write fails the call is refused, so no call reaches
  // an upstream without a row. The row is completed when the call ends.
  async function callAsUser(principal: Principal | undefined, source: Source, name: string, args: Record<string, unknown> | undefined,
    ctx: { requestId?: string } = {}): Promise<CallResult & { durationMs: number; auditId?: number }> {
    const t0 = Date.now();
    const requestId = ctx.requestId ?? newRequestId();
    const i = name.indexOf(SEPARATOR);
    const target = manager.resolve(name);
    const serverPrefix = target?.upstream.prefix ?? (i > 0 ? name.slice(0, i) : null);
    const toolName = target?.tool ?? (i > 0 ? name.slice(i + SEPARATOR.length) : name);
    const tooDeep = depthOver(args, MAX_ARG_DEPTH);
    let auditId: number;
    try {
      auditId = await beginAudit(db, { userId: principal?.userId, apiKeyId: principal?.apiKeyId, keyPrefix: principal?.keyPrefix,
        oauthGrantId: principal?.oauthGrantId, source, serverPrefix, tool: toolName, argsSha256: tooDeep ? null : argsHash(args), requestId });
    } catch (e) {
      log.error({ err: String(e) }, 'audit write failed; call refused');
      auditUnavailable.inc({ source });
      return { result: { content: [{ type: 'text', text: 'The gateway cannot write its audit log right now, so it refuses tool calls. Try again shortly.' }], isError: true },
        outcome: 'rejected', error: 'audit unavailable', durationMs: Date.now() - t0 };
    }
    const r: CallResult = tooDeep
      ? { result: { content: [{ type: 'text', text: `Arguments nested deeper than ${MAX_ARG_DEPTH} levels are refused.` }], isError: true },
        outcome: 'rejected', upstream: target?.upstream, tool: target?.tool, error: 'arguments nested too deeply' }
      : target && !perms.allows(principal?.role, target.upstream.prefix, target.tool, manager.readOnly(target.upstream.prefix, target.definition))
      ? {
        result: { content: [{ type: 'text', text: `Tool "${name}" is not available to your role (${principal?.role ?? 'unknown'}). Ask an admin if you need it.` }], isError: true },
        outcome: 'denied', upstream: target.upstream, tool: target.tool, error: `not allowed for role ${principal?.role ?? 'unknown'}`,
      }
      : await manager.callTool(name, args, { requestId });
    // A model that invents a tool name recovers faster with a hint. Suggestions come from the
    // caller's own tools only, so they never reveal a tool the caller may not use.
    if (!target && r.outcome === 'rejected' && !tooDeep) {
      const hints = searchTools(principal, name.replace(/_/g, ' '), 3).map(t => t.name).filter(n => n !== name);
      if (hints.length) r.result = { ...r.result, content: [{ type: 'text', text: `${(r.result.content[0] as { text: string }).text}. Did you mean: ${hints.join(', ')}?` }] };
    }
    const durationMs = Date.now() - t0;
    await finishAudit(db, auditId, {
      upstreamId: r.upstream?.id,
      serverPrefix: r.upstream?.prefix ?? serverPrefix,
      tool: r.tool ?? toolName,
      durationMs,
      outcome: r.outcome,
      error: r.error,
    }).catch(e => log.error({ err: String(e), auditId }, 'audit update failed; the row stays pending until the sweep marks it unknown'));
    // Metric labels come only from the registry: a name that resolved to no server is "(unknown)",
    // so made-up tool names cannot add series without end (the audit row keeps the name as sent).
    const server = r.upstream?.prefix ?? 'unknown';
    toolCalls.inc({ server, tool: r.upstream ? (r.tool ?? toolName) : '(unknown)', outcome: r.outcome, source });
    toolCallSeconds.observe({ server, outcome: r.outcome }, durationMs / 1000);
    return { ...r, durationMs, auditId };
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

  // Chat confirmation (C). A name that resolves to no tool needs none: its call is refused (and
  // audited) anyway.
  function needsConfirm(name: string): boolean {
    const t = manager.resolve(name);
    return Boolean(t) && asksInChat(perms.confirmMode(t!.upstream.prefix, t!.tool), manager.readOnly(t!.upstream.prefix, t!.definition));
  }

  return { listToolsFor, callAsUser, searchTools, needsConfirm };
}
export type GatewayCore = ReturnType<typeof createGatewayCore>;

// Arguments: refused past this depth before anything parses them further (an iterative walk, so a
// hostile document cannot overflow the stack); hashed for the audit as canonical JSON.
const MAX_ARG_DEPTH = 32;
function depthOver(v: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[v, 0]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (!x || typeof x !== 'object') continue;
    if (d >= max) return true;
    for (const c of Object.values(x)) stack.push([c, d + 1]);
  }
  return false;
}
const argsHash = (args: Record<string, unknown> | undefined) => createHash('sha256').update(stable(args ?? {})).digest('hex');
// 128 random bits as 32 hex: valid as a W3C trace id, meaningless outside this system.
export const newRequestId = () => randomBytes(16).toString('hex');

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
    const requestId = authInfo?.extra?.requestId as string | undefined;
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
        return (await core.callAsUser(principal, source, args.name, (args.arguments ?? {}) as Record<string, unknown>, { requestId })).result;
      }
      return (await core.callAsUser(principal, source, name, args, { requestId })).result;
    });
    return server;
  });
}
