// The chat agent on its fallback provider (E), against a deployed platform started with
// CHAT_FORCE_FALLBACK=1 (every Gemini attempt fails as if overloaded; verify-dod sets and clears it).
// Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, ORDER_ID, ORDER_DAY. Creates nothing: the one write is
// proposed and cancelled.
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(48)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(48)} ${e.message}`); }
}
const { BASE, ADMIN_EMAIL, ADMIN_PASSWORD, ORDER_ID = '16', ORDER_DAY = '2026-10-15' } = process.env;
let cookie = '';
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of r.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
  return r;
}
async function chat(text) {
  const t0 = Date.now();
  const r = await call('POST', '/api/chat', { messages: [{ role: 'user', text }] });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  const events = (await r.text()).split('\n\n').filter(c => c.startsWith('data: ')).map(c => JSON.parse(c.slice(6)));
  return { events, ms: Date.now() - t0, models: events.filter(e => e.type === 'model').map(e => e.model), tools: events.filter(e => e.type === 'tool_end'),
    answer: events.find(e => e.type === 'text')?.text ?? '', error: events.find(e => e.type === 'error')?.message, proposal: events.find(e => e.type === 'confirm') };
}
must((await call('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).ok, 'login failed');
const status = await (await call('GET', '/api/chat/status')).json();
const startedAt = new Date().toISOString();
await check('status lists the fallback', async () => {
  must(status.enabled && status.fallback && status.models.at(-1) === status.fallback, JSON.stringify(status));
  return `models ${status.models.join(' -> ')}`;
});
const onFallback = c => c.models.at(-1)?.startsWith(status.fallback);
await check('Gemini down: the fallback answers with tools', async () => {
  const c = await chat(`What orders came in on ${ORDER_DAY}? List each with its order number and total.`);
  must(!c.error, c.error);
  must(onFallback(c), `answered by ${c.models.join(' -> ')}`);
  must(c.tools.some(t => t.name === 'woo__list_orders' && t.outcome === 'ok'), `tools [${c.tools.map(t => `${t.name}:${t.outcome}`)}]`);
  must(c.answer.includes(ORDER_ID) && !/<think>/i.test(c.answer), `answer: ${c.answer.slice(0, 160)}`);
  return `${c.ms} ms, ${c.models.join(' -> ')}, tools [${c.tools.map(t => `${t.name}:${t.outcome}`)}]`;
});
await check('C holds on the fallback: a write is only proposed', async () => {
  const c = await chat('Create a product called "TEST fallback mug" priced at 5 as a draft.');
  must(!c.error, c.error);
  must(onFallback(c), `answered by ${c.models.join(' -> ')}`);
  must(c.proposal?.name === 'woo__create_product' && !c.events.some(e => e.type === 'tool_start' && e.name === 'woo__create_product'), `no proposal (${c.answer.slice(0, 120)})`);
  const r = await call('POST', `/api/chat/proposals/${c.proposal.id}`, { decision: 'reject' });
  must(r.ok, `reject -> ${r.status}`);
  return `${c.ms} ms; "${c.proposal.summary}"; cancelled`;
});
await check('fallback calls audited as the user, source chat', async () => {
  const rows = (await (await call('GET', '/api/audit?limit=50')).json()).events.filter(e => e.at >= startedAt && e.source === 'chat');
  must(rows.some(e => e.tool === 'list_orders' && e.outcome === 'ok') && rows.every(e => e.user === ADMIN_EMAIL) && !rows.some(e => e.tool === 'create_product'), JSON.stringify(rows.map(e => [e.user, e.tool, e.outcome])));
  return `${rows.length} rows under ${ADMIN_EMAIL}; no create_product`;
});
console.log(failed ? `CHAT FALLBACK CHECK FAILED (${failed})` : 'CHAT FALLBACK CHECK PASSED');
process.exit(failed ? 1 : 0);
