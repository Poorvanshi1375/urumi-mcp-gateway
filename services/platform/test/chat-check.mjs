// Chat agent checks (C1–C4, D2/D3/D5 mechanisms) against a deployed platform with a Gemini key.
// Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD. Creates one draft product named "TEST chat tote" (not on
// the storefront) and temporarily disables the "ship" server.
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(46)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(46)} ${e.message}`); }
}
// ORDER_ID / ORDER_DAY: the store's newest order and its day (store timezone), from verify-dod.
const { BASE, ADMIN_EMAIL, ADMIN_PASSWORD, ORDER_ID = '16', ORDER_DAY = '2026-10-15' } = process.env;
const trackPrefix = `URS${ORDER_ID.padStart(6, '0')}`;
let cookie = '';
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of r.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
  return r;
}
// Run one chat turn and collect the streamed events.
async function chat(text) {
  const t0 = Date.now();
  const r = await call('POST', '/api/chat', { messages: [{ role: 'user', text }] });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  const events = (await r.text()).split('\n\n').filter(c => c.startsWith('data: ')).map(c => JSON.parse(c.slice(6)));
  const tools = events.filter(e => e.type === 'tool_end');
  const answer = events.find(e => e.type === 'text')?.text ?? '';
  const error = events.find(e => e.type === 'error')?.message;
  return { events, tools, answer, error, ms: Date.now() - t0, model: events.filter(e => e.type === 'model').map(e => e.model).join('→') };
}
const summary = c => `${c.ms} ms, ${c.model}, tools [${c.tools.map(t => `${t.name}:${t.outcome}`).join(', ')}]`;

await check('no session -> 401', async () => { const r = await call('POST', '/api/chat', { messages: [{ role: 'user', text: 'hi' }] }); must(r.status === 401, r.status); return `${r.status}`; });
const login = await call('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
must(login.ok, `login failed ${login.status}`);
const startedAt = new Date().toISOString();
await check('non-JSON -> 415 (CSRF guard)', async () => {
  const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: 'hi' });
  must(r.status === 415, r.status); return `${r.status}`;
});
await check('status: enabled', async () => {
  const s = await (await call('GET', '/api/chat/status')).json(); must(s.enabled, JSON.stringify(s)); return `model ${s.model}, ${s.tools} tools`;
});
await check('orders on a day -> woo__list_orders (C1, D3)', async () => {
  const c = await chat(`What orders came in on ${ORDER_DAY}? List each with its order number, customer and total.`);
  must(!c.error, c.error); must(c.tools.some(t => t.name === 'woo__list_orders' && t.outcome === 'ok'), summary(c));
  must(c.answer.includes(ORDER_ID), `answer lacks #${ORDER_ID}: ${c.answer.slice(0, 160)}`);
  must(c.answer.includes('₹') || !c.answer.includes('$'), `currency: ${c.answer.slice(0, 120)}`);
  return summary(c);
});
await check('create a product (D2 mechanism)', async () => {
  const c = await chat('Create a product called "TEST chat tote" priced at 799 as a draft (do not publish it).');
  must(!c.error, c.error); must(c.tools.some(t => t.name === 'woo__create_product' && t.outcome === 'ok'), summary(c));
  return summary(c);
});
await check('one prompt, two servers (D5)', async () => {
  const c = await chat(`For order ${ORDER_ID}: what items were ordered, and where is its shipment right now?`);
  must(!c.error, c.error);
  const names = new Set(c.tools.filter(t => t.outcome === 'ok').map(t => t.name));
  must(names.has('woo__get_order') && names.has('ship__get_order'), summary(c));
  must(c.answer.includes(trackPrefix), `no tracking number in answer: ${c.answer.slice(0, 160)}`);
  return summary(c);
});
await check('disabled server hidden from the agent (C4)', async () => {
  must((await call('PATCH', '/api/servers/ship', { enabled: false })).ok, 'disable failed');
  try {
    const c = await chat(`Where is the shipment for order ${ORDER_ID}? Use the shipping tool.`);
    must(!c.error, c.error);
    must(!c.tools.some(t => t.name.startsWith('ship__')), `called ship while disabled: ${summary(c)}`);
    return `${summary(c)}; answer: "${c.answer.replace(/\s+/g, ' ').slice(0, 110)}…"`;
  } finally { await call('PATCH', '/api/servers/ship', { enabled: true }); }
});
await check('chat calls audited as the user, source chat (C2)', async () => {
  const r = await (await call('GET', '/api/audit?limit=50')).json();
  const rows = r.events.filter(e => e.at >= startedAt && e.source === 'chat');
  must(rows.length >= 4 && rows.every(e => e.user === ADMIN_EMAIL), JSON.stringify(rows.map(e => [e.user, e.server, e.tool, e.outcome])));
  return `${rows.length} chat rows under ${ADMIN_EMAIL}: ${[...new Set(rows.map(e => `${e.server}/${e.tool}`))].join(', ')}`;
});
console.log(failed ? `CHAT CHECK FAILED (${failed})` : 'CHAT CHECK PASSED');
process.exit(failed ? 1 : 0);
