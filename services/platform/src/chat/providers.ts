// LLM providers for the chat agent (E). The agent talks to a Conversation: one step asks the model
// for its next answer (text and/or tool calls), addResults hands it the tool results. Each provider
// keeps the history in its own wire format, so nothing Gemini-specific (thought signatures) ever
// reaches another provider: a turn that fails over to the fallback stays there until it ends.
import type { Tool } from '@modelcontextprotocol/client';
import type { ChatTurn } from './agent.ts';

export type Call = { name: string; args?: Record<string, unknown>; id?: string };
export type StepOut = { text: string; calls: Call[] };
export type ToolResult = { call: Call; text: string; isError: boolean };   // text is already wrapped
export interface Conversation {
  step(signal: AbortSignal): Promise<StepOut>;
  addResults(results: ToolResult[]): void;
}

// An HTTP error from a model API, with the provider's message.
export class LlmError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}

// ---- Gemini (generateContent)

type Part = Record<string, any>;
type Content = { role: 'user' | 'model'; parts: Part[] };
export type GeminiResponse = { candidates?: { content?: Content; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
export type GeminiGenerate = (apiKey: string, model: string, body: object, signal: AbortSignal, timeoutMs: number) => Promise<GeminiResponse>;

export const geminiGenerate: GeminiGenerate = async (apiKey, model, body, signal, timeoutMs) => {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new LlmError(res.status, data?.error?.message ?? `HTTP ${res.status}`);
  return data as GeminiResponse;
};

// Gemini takes JSON Schema via parametersJsonSchema; drop keys it does not need.
function geminiDeclaration(t: Tool) {
  return { name: t.name, description: (t.description ?? '').slice(0, 1000), parametersJsonSchema: providerSchema(t.inputSchema) };
}

// One conversation shared by all Gemini models of a turn: switching from flash to flash-lite keeps
// the history, including the thought signatures the next request needs.
export function geminiChat(o: { apiKey: string; system: string; history: ChatTurn[]; tools: Tool[]; timeoutMs: number; generate: GeminiGenerate }) {
  const contents: Content[] = o.history.map(t => ({ role: t.role === 'user' ? 'user' : 'model', parts: [{ text: t.text }] }));
  const base = { systemInstruction: { parts: [{ text: o.system }] }, ...(o.tools.length ? { tools: [{ functionDeclarations: o.tools.map(geminiDeclaration) }] } : {}) };
  let last: Content | undefined;
  return (model: string): Conversation => ({
    async step(signal) {
      const data = await o.generate(o.apiKey, model, { ...base, contents }, signal, o.timeoutMs);
      if (data.promptFeedback?.blockReason) throw new Error(`The request was blocked by the model (${data.promptFeedback.blockReason}).`);
      last = data.candidates?.[0]?.content;
      const parts = last?.parts ?? [];
      return {
        text: parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join(''),
        calls: parts.filter(p => p.functionCall).map(p => p.functionCall as Call),
      };
    },
    addResults(results) {
      // Keep the model turn verbatim: it carries thought signatures the next request needs.
      contents.push(last!);
      contents.push({ role: 'user', parts: results.map(r => ({ functionResponse: { name: r.call.name, ...(r.call.id ? { id: r.call.id } : {}), response: r.isError ? { error: r.text } : { result: r.text } } })) });
    },
  });
}

// ---- OpenAI-compatible chat completions (Groq, OpenRouter, ...)

export type FallbackConfig = { baseUrl: string; model: string; apiKey: string; timeoutMs: number };
type Message = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[]; tool_call_id?: string };

// JSON Schema keywords some OpenAI-compatible APIs reject in tool parameters. Our tool schemas are
// self-contained (no $ref), so dropping these changes nothing a model needs.
const DROPPED = new Set(['$schema', '$id', '$comment', '$defs', 'definitions']);
export function providerSchema(schema: unknown): Record<string, unknown> {
  const clean = (v: unknown): unknown => Array.isArray(v) ? v.map(clean)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !DROPPED.has(k)).map(([k, x]) => [k, clean(x)])) : v;
  return (clean(schema ?? { type: 'object', properties: {} }) as Record<string, unknown>);
}

// Reasoning models may put their thinking in the answer; the user sees only the answer.
export const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();

export function openaiChat(o: { cfg: FallbackConfig; system: string; history: ChatTurn[]; tools: Tool[]; fetch?: typeof fetch }): Conversation {
  const doFetch = o.fetch ?? fetch;
  const messages: Message[] = [{ role: 'system', content: o.system }, ...o.history.map(t => ({ role: t.role, content: t.text }) as Message)];
  const tools = o.tools.map(t => ({ type: 'function', function: { name: t.name, description: (t.description ?? '').slice(0, 1000), parameters: providerSchema(t.inputSchema) } }));
  async function request(signal: AbortSignal) {
    const res = await doFetch(`${o.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.cfg.apiKey}` },
      body: JSON.stringify({ model: o.cfg.model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(o.cfg.timeoutMs)]),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new LlmError(res.status, data?.error?.message ?? `HTTP ${res.status}`, data?.error?.code);
    return data as { choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
  }
  return {
    async step(signal) {
      let data;
      try {
        data = await request(signal);
      } catch (e) {
        // The API refused the model's own tool call (it broke the tool's schema): tell the model what
        // it broke and let it try once more (E+).
        if (!(e instanceof LlmError && e.code === 'tool_use_failed')) throw e;
        messages.push({ role: 'user', content: `Your last tool call was rejected: ${e.message.slice(0, 500)}. Call the tool again with arguments that match its schema exactly.` });
        data = await request(signal);
      }
      const m = data.choices?.[0]?.message ?? {};
      const toolCalls = m.tool_calls ?? [];
      messages.push({ role: 'assistant', content: m.content ?? '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      return {
        text: stripThinking(m.content ?? ''),
        calls: toolCalls.map(c => {
          let args: Record<string, unknown> = {};
          try { const v = JSON.parse(c.function.arguments || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) args = v; } catch { /* the gateway reports the bad arguments */ }
          return { id: c.id, name: c.function.name, args };
        }),
      };
    },
    addResults(results) {
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.call.id ?? r.call.name, content: r.text });
    },
  };
}
