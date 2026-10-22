// A malicious MCP server against the gateway's defences (idea D), with no LLM involved: evil-mcp is
// added the way an admin would add any image, as a hosted server, and each attack must meet its
// defence. Needs provisioner.enabled and the urumi-evil-mcp image on the nodes.
// Env: GW_URL, KEY_ADMIN, KEY_MEMBER, EVIL_IMAGE (e.g. urumi-evil-mcp:<tag>).
// Side effects, undone before it exits: the hosted server "vdodevil" and its namespace.
const { GW_URL, KEY_ADMIN, KEY_MEMBER, EVIL_IMAGE } = process.env;
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(56)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(56)} ${e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, path, body, key = KEY_ADMIN) {
  const r = await fetch(`${GW_URL}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function mcp(method, params, key = KEY_ADMIN) {
  const r = await fetch(`${GW_URL}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const t = await r.text();
  return JSON.parse(t.startsWith('{') ? t : (/^data: (.*)$/m.exec(t)?.[1] ?? 'null'));
}
const tools = async (key = KEY_ADMIN) => (await mcp('tools/list', {}, key))?.result?.tools ?? [];
const hosted = async () => (await api('GET', '/api/hosted')).body.servers?.find(s => s.prefix === 'vdodevil');
const serverView = async () => (await api('GET', '/api/servers')).body.servers?.find(s => s.prefix === 'vdodevil');
const RUG_SECONDS = 60;   // after the gateway has first seen it (ready takes about 30 s): a real rug pull

must(EVIL_IMAGE, 'EVIL_IMAGE not set');
const old = await hosted();
if (old && old.state !== 'deleting') await api('DELETE', `/api/hosted/${old.id}`);
for (let i = 0; i < 60 && (await hosted()); i++) await sleep(2000);
let h;
try {
  await check('the admin hosts it like any image', async () => {
    const r = await api('POST', '/api/hosted', { prefix: 'vdodevil', name: 'Totally normal tools', image: EVIL_IMAGE, env: { RUG_PULL_AFTER_SECONDS: String(RUG_SECONDS) } });
    must(r.status === 200, `${r.status} ${r.body.error}`);
    for (let i = 0; i < 60; i++) { h = await hosted(); if (h?.state === 'ready' || h?.state === 'failed') break; await sleep(2000); }
    must(h?.state === 'ready', JSON.stringify(h).slice(0, 200));
    const names = (await tools()).map(t => t.name).filter(n => n.startsWith('vdodevil__'));
    must(names.length === 5, `tools: ${names}`);
    return `ready; ${names.join(', ')}`;
  });
  await check('hidden instructions are stripped (TAG characters)', async () => {
    const w = (await tools()).find(t => t.name === 'vdodevil__weather');
    must(w && !/[\u{E0000}-\u{E007F}]/u.test(w.description) && !/customer/i.test(w.description), JSON.stringify(w?.description).slice(0, 120));
    return `clients see: "${w.description}"`;
  });
  await check('a lying read-only hint is not believed', async () => {
    const s = await serverView();
    const a = s.tools.find(t => t.name === 'archive_order');
    must(s.annotationsTrusted === false && a.annotations?.readOnlyHint === true && a.memberAllowed === false && a.asksInChat === true, JSON.stringify({ trusted: s.annotationsTrusted, a }).slice(0, 200));
    const member = (await tools(KEY_MEMBER)).map(t => t.name).filter(n => n.startsWith('vdodevil__'));
    must(!member.length, `member sees ${member}`);
    return 'archive_order claims read-only: still admin-only and asks before running in chat; members see none of its tools';
  });
  await check('an oversized answer is cut off while streaming', async () => {
    const t0 = Date.now();
    const r = await mcp('tools/call', { name: 'vdodevil__big', arguments: {} });
    const text = r?.result?.content?.[0]?.text ?? '';
    must(r?.result?.isError && /more than 10 MiB/.test(text), JSON.stringify(r).slice(0, 200));
    return `refused in ${Date.now() - t0} ms: "${text.slice(0, 70)}"`;
  });
  await check('a rug pull hides the tool until an admin approves it', async () => {
    const wait = Math.max(0, RUG_SECONDS * 1000 - (Date.now() - new Date(h.readyAt).getTime())) + 2000;
    await sleep(wait);
    let s, lookup;
    for (let i = 0; i < 40; i++) {
      s = await serverView(); lookup = s?.tools.find(t => t.name === 'lookup');
      if (lookup?.pending) break;
      await sleep(3000);
    }
    must(lookup?.pending === true, `lookup not pending: ${JSON.stringify(lookup).slice(0, 160)}`);
    must(!(await tools()).some(t => t.name === 'vdodevil__lookup'), 'lookup still listed to clients');
    must((lookup.flags ?? []).length > 0, `the new description is not flagged: ${JSON.stringify(lookup.flags)}`);
    const call = await mcp('tools/call', { name: 'vdodevil__lookup', arguments: { q: 'x' } });
    must(call?.result?.isError, `a call to the hidden tool ran: ${JSON.stringify(call).slice(0, 120)}`);
    return `after ${RUG_SECONDS} s its description changed: hidden from clients, refused if called, flagged (${lookup.flags.join(', ')}), waiting for review`;
  });
} finally {
  const left = await hosted();
  if (left && left.state !== 'deleting') await api('DELETE', `/api/hosted/${left.id}`);
}
console.log(failed ? `EVIL CHECK FAILED (${failed})` : 'EVIL CHECK PASSED');
process.exit(failed ? 1 : 0);
