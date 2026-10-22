// Leases and compare-and-set writes for the provisioner's rows (H1, H2), against the real Postgres.
// Runs inside a gateway pod, as the app role, by piping this file in (the image has /app/src, not
// test/): kubectl exec -i deploy/platform -c platform -- node --input-type=module < this file
// Uses its own hosted_servers rows (prefix vdodl*), removed at the end.
import { sql } from 'drizzle-orm';   // resolved from the pod's working directory, /app
import { createDb } from '/app/src/db/client.ts';
import { claim, release, renew, requestDelete, requestRetry, writeIfState } from '/app/src/provision/rows.ts';

const { pool, db } = createDb();
let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { console.log(`PASS  ${name.padEnd(50)} ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL  ${name.padEnd(50)} ${e.message}`); }
}
const q = async s => (await db.execute(s)).rows;
const row = async prefix => (await q(sql`select * from hosted_servers where prefix = ${prefix}`))[0];
const add = (prefix, extra = sql``) => db.execute(sql`insert into hosted_servers (prefix, name, image, deadline_at) values (${prefix}, ${prefix}, 'docker.io/mcp/x:1', now() + interval '3 minutes') ${extra}`);
const ours = rs => rs.filter(r => r.prefix.startsWith('vdodl'));

try {
  await db.execute(sql`delete from hosted_servers where prefix like 'vdodl%'`);
  for (const p of ['vdodla', 'vdodlb', 'vdodlc', 'vdodld']) await add(p);

  await check('H1: concurrent claims never share a row', async () => {
    const [a, b] = await Promise.all([claim(db, 'hosted_servers', 'proc-a', 2), claim(db, 'hosted_servers', 'proc-b', 2)]);
    const pa = ours(a).map(r => r.prefix), pb = ours(b).map(r => r.prefix);
    must(pa.length + pb.length === 4 && !pa.some(p => pb.includes(p)), `a=${pa} b=${pb}`);
    const again = ours(await claim(db, 'hosted_servers', 'proc-c', 10));
    must(again.length === 0, `leased rows claimed again: ${again.map(r => r.prefix)}`);
    return `a got ${pa.join(',')}, b got ${pb.join(',')}; a third claim gets none of them`;
  });
  const owner = async p => (await row(p)).lease_owner;
  const A = await owner('vdodla');

  await check('H1: only the holder renews; release frees the row', async () => {
    must(await renew(db, 'hosted_servers', (await row('vdodla')).id, A) === true, 'holder could not renew');
    must(await renew(db, 'hosted_servers', (await row('vdodla')).id, 'intruder') === false, 'another process renewed the lease');
    await release(db, 'hosted_servers', (await row('vdodla')).id, A);
    must((await row('vdodla')).lease_owner === null, 'not released');
    const c = ours(await claim(db, 'hosted_servers', 'proc-c', 10)).map(r => r.prefix);
    must(c.join() === 'vdodla', `after release, claim got ${c}`);
    return 'renew by holder true, by another false; released row claimed by the next process';
  });

  await check('H2: a Delete supersedes a running install', async () => {
    const r = await row('vdodlb'), held = r.lease_owner;
    must(await writeIfState(db, 'hosted_servers', r.id, held, 'provisioning', { step: 'namespace' }) === true, 'first write failed');
    must(await requestDelete(db, 'hosted_servers', r.id) === true, 'delete request failed');
    must(await writeIfState(db, 'hosted_servers', r.id, held, 'provisioning', { step: 'secret' }) === false, 'install overwrote the delete');
    const now = await row('vdodlb');
    must(now.state === 'deleting' && now.step === 'namespace', `${now.state}/${now.step}`);
    must(await requestDelete(db, 'hosted_servers', r.id) === false, 'a second delete request changed the row again');
    return 'install write ok, then Delete; the next install write matched no row; state deleting, step still namespace';
  });

  await check('H2: a write needs the lease too', async () => {
    const r = await row('vdodlc');
    must(await writeIfState(db, 'hosted_servers', r.id, 'not-the-holder', 'provisioning', { step: 'x' }) === false, 'a non-holder wrote');
    return 'right state, wrong owner -> no write';
  });

  await check('H1: an expired lease is taken over', async () => {
    const r = await row('vdodlb');   // deleting, still leased by the install's process
    await db.execute(sql`update hosted_servers set lease_until = now() - interval '1 second' where id = ${r.id}`);
    const got = ours(await claim(db, 'hosted_servers', 'proc-d', 10)).map(x => x.prefix);
    must(got.includes('vdodlb'), `claim got ${got}`);
    must(await writeIfState(db, 'hosted_servers', r.id, r.lease_owner, 'deleting', { step: 'unregister' }) === false, 'the old holder still wrote');
    must(await writeIfState(db, 'hosted_servers', r.id, 'proc-d', 'deleting', { step: 'unregister' }) === true, 'the new holder could not write');
    return 'expired row claimed by proc-d; the old holder\'s write refused, the new one\'s accepted';
  });

  await check('H1: rows in backoff are not claimed', async () => {
    await add('vdodle', sql``);
    await db.execute(sql`update hosted_servers set next_attempt_at = now() + interval '1 minute' where prefix = 'vdodle'`);
    const got = ours(await claim(db, 'hosted_servers', 'proc-e', 10)).map(x => x.prefix);
    must(!got.includes('vdodle'), `claimed during backoff: ${got}`);
    return 'next_attempt_at in the future -> skipped';
  });

  await check('teardown: gone deletes the row; Retry only from failed', async () => {
    const r = await row('vdodlb');
    must(await writeIfState(db, 'hosted_servers', r.id, 'proc-d', 'deleting', { gone: true }) === true && !(await row('vdodlb')), 'row not deleted');
    const c = await row('vdodlc');
    must(await requestRetry(db, 'hosted_servers', c.id, 180_000) === false, 'retried a provisioning row');
    await db.execute(sql`update hosted_servers set state = 'failed', error = 'x', attempts = 4 where id = ${c.id}`);
    must(await requestRetry(db, 'hosted_servers', c.id, 180_000) === true, 'retry of a failed row refused');
    const after = await row('vdodlc');
    must(after.state === 'provisioning' && after.attempts === 0 && after.error === null && new Date(after.deadline_at) > new Date(), JSON.stringify(after).slice(0, 160));
    return 'gone -> row deleted; retry refused while provisioning, accepted when failed (fresh deadline)';
  });
} finally {
  await db.execute(sql`delete from hosted_servers where prefix like 'vdodl%'`).catch(() => {});
  await pool.end();
}
console.log(failed ? `PROVISION ROWS CHECK FAILED (${failed})` : 'PROVISION ROWS CHECK PASSED');
process.exit(failed ? 1 : 0);
