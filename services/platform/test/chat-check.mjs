// Chat agent checks (C1–C4, D2/D3/D5 mechanisms) against a deployed platform with a Gemini key.
// Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, KEY_OTHER (another user's API key). Creates one draft
// product named "TEST chat tote" (not on the storefront) and temporarily disables the "ship" server.
// With platform.chat.confirmWrites on, the product is created only after the confirm step (C).
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
// A used-up model quota is not something these checks can test past: once a turn reports it, no
// further model calls are made (they would only use more quota) and the rest is skipped. The run
// then exits 3, "incomplete": still a failure, never a pass.
let llmDown = null;
async function check(name, fn) {
  if (llmDown) { console.log(`SKIP  ${name.padEnd(46)} not run: the language model is unavailable`); return; }
  try { console.log(`PASS  ${name.padEnd(46)} ${await fn()}`); }
  catch (e) { if (!llmDown) failed++; console.log(`${llmDown ? 'STOP' : 'FAIL'}  ${name.padEnd(46)} ${e.message}`); }
}
// ORDER_ID / ORDER_DAY: the store's newest order and its day (store timezone), from verify-dod.
const { BASE, ADMIN_EMAIL, ADMIN_PASSWORD, KEY_OTHER, ORDER_ID = '16', ORDER_DAY = '2026-10-15' } = process.env;
const trackPrefix = `URS${ORDER_ID.padStart(6, '0')}`;
let cookie = '';
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of r.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
  return r;
}
// The per-user chat limit (burst 5) is not what these checks test: wait it out once if hit.
async function limited(fn) {
  const r = await fn();
  if (r.status !== 429) return r;
  const s = Number(/in (\d+) s/.exec(await r.text())?.[1] ?? 10);
  await new Promise(res => setTimeout(res, (s + 1) * 1000));
  return fn();
}
const sse = async r => (await r.text()).split('\n\n').filter(c => c.startsWith('data: ')).map(c => JSON.parse(c.slice(6)));
// Run one chat turn and collect the streamed events.
async function chat(text) {
  const t0 = Date.now();
  const r = await limited(() => call('POST', '/api/chat', { messages: [{ role: 'user', text }] }));
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  const events = await sse(r);
  const tools = events.filter(e => e.type === 'tool_end');
  const answer = events.find(e => e.type === 'text')?.text ?? '';
  const error = events.find(e => e.type === 'error')?.message;
  if (/quota is used up/.test(error ?? '')) { llmDown = error; throw new Error(error); }
  return { events, tools, answer, error, ms: Date.now() - t0, model: events.filter(e => e.type === 'model').map(e => e.model).join('→'), proposal: events.find(e => e.type === 'confirm') };
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
await check('A: a day total is the store\'s amount_total, not model arithmetic', async () => {
  const c = await chat(`How many orders came in on ${ORDER_DAY}, and what is their total amount?`);
  must(!c.error, c.error);
  const t = c.tools.find(x => x.name === 'woo__list_orders' && x.outcome === 'ok');
  must(t, summary(c));
  const amount = /"amount_total":\s*"(-?\d+(?:\.\d+)?)"/.exec(t.preview ?? '')?.[1];
  must(amount, `no amount_total in the tool result: ${(t.preview ?? '').slice(0, 160)}`);
  const plain = c.answer.replace(/(\d),(?=\d)/g, '$1');   // 1,234.50 -> 1234.50
  must(plain.includes(amount), `answer does not state ${amount}: ${c.answer.slice(0, 200)}`);
  return `amount_total ${amount} stated as returned; ${summary(c)}`;
});
const decide = (id, decision, headers) => limited(() => call('POST', `/api/chat/proposals/${id}`, { decision }, headers));
const auditRows = async () => (await (await call('GET', '/api/audit?limit=100')).json()).events.filter(e => e.at >= startedAt && e.source === 'chat');
const status = await (await call('GET', '/api/chat/status')).json();
if (!status.confirmWrites) {
  await check('create a product (D2 mechanism)', async () => {
    const c = await chat('Create a product called "TEST chat tote" priced at 799 as a draft (do not publish it).');
    must(!c.error, c.error); must(c.tools.some(t => t.name === 'woo__create_product' && t.outcome === 'ok'), summary(c));
    return summary(c);
  });
} else {
  let proposal;
  await check('C: a write is proposed, not run', async () => {
    const c = await chat('Create a product called "TEST chat tote" priced at 799 as a draft (do not publish it).');
    must(!c.error, c.error);
    proposal = c.proposal;
    must(proposal?.name === 'woo__create_product' && /tote/i.test(proposal.summary), `no proposal: ${summary(c)}`);
    must(!c.events.some(e => e.type === 'tool_start' && e.name === 'woo__create_product'), 'create_product started before confirmation');
    must(c.events.find(e => e.type === 'done')?.awaitingConfirmation === true, 'done without awaitingConfirmation');
    must(!(await auditRows()).some(e => e.tool === 'create_product'), 'audit has a create_product row before confirmation');
    const waiting = (await (await call('GET', '/api/chat/proposals')).json()).proposals;
    must(waiting.some(p => p.id === proposal.id), 'not listed as waiting');
    return `"${proposal.summary}"; no tool_start, no audit row; listed as waiting`;
  });
  await check('C: another user cannot confirm it', async () => {
    must(KEY_OTHER, 'KEY_OTHER not set');
    const r = await fetch(`${BASE}/api/chat/proposals/${proposal.id}`, { method: 'POST', headers: { authorization: `Bearer ${KEY_OTHER}`, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'confirm' }) });
    must(r.status === 404, `${r.status} ${await r.text()}`);
    return '404';
  });
  await check('C: confirm runs it once, audited (D2 mechanism)', async () => {
    const r = await decide(proposal.id, 'confirm');
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const ev = await sse(r);
    const end = ev.find(e => e.type === 'tool_end' && e.name === 'woo__create_product');
    must(end?.outcome === 'ok' && /"id":\s*\d+/.test(end.preview), JSON.stringify(ev).slice(0, 300));
    const text = ev.find(e => e.type === 'text')?.text ?? '';
    must(text.length > 0, 'no result text');
    const again = await decide(proposal.id, 'confirm');
    must(again.status === 409, `second confirm -> ${again.status}`);
    const rows = (await auditRows()).filter(e => e.tool === 'create_product');
    must(rows.length === 1 && rows[0].outcome === 'ok', JSON.stringify(rows));
    return `ok in ${end.durationMs} ms; "${text.replace(/\s+/g, ' ').slice(0, 70)}…"; second confirm 409; one audit row`;
  });
  await check('C: cancel runs nothing and needs no model; new message declines', async () => {
    const c = await chat('Create a product called "TEST chat cancelled" priced at 5 as a draft.');
    must(c.proposal?.name === 'woo__create_product', `no proposal: ${summary(c)}`);
    const t0 = Date.now();
    const r = await decide(c.proposal.id, 'reject');
    const body = await r.json();
    must(r.ok && /^Cancelled: /.test(body.text) && /Nothing was changed/.test(body.text), JSON.stringify(body));
    const ms = Date.now() - t0;
    const c2 = await chat('Create a product called "TEST chat superseded" priced at 5 as a draft.');
    must(c2.proposal, `no proposal: ${summary(c2)}`);
    await chat('Never mind. How many products does the store have? Just the number.');
    const late = await decide(c2.proposal.id, 'confirm');
    must(late.status === 409, `confirm after a new message -> ${late.status}`);
    must(!(await auditRows()).some(e => e.tool === 'create_product' && e.outcome !== 'ok') && (await auditRows()).filter(e => e.tool === 'create_product').length === 1, 'a cancelled or declined write reached the audit');
    return `cancel answered in ${ms} ms; a new message declined the waiting one (confirm -> 409); still one create_product row`;
  });
}
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
if (llmDown) {
  console.log(`CHAT CHECK INCOMPLETE: ${llmDown}${failed ? ` (and ${failed} failed before that)` : ''}`);
  console.log('Not a code failure by itself: rerun after the quota resets (free tier: midnight Pacific) or with a key that has quota.');
  process.exit(3);
}
console.log(failed ? `CHAT CHECK FAILED (${failed})` : 'CHAT CHECK PASSED');
process.exit(failed ? 1 : 0);
