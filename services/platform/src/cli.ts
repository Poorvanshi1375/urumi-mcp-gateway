// Admin CLI until the dashboard exists (same service layer the dashboard API will use).
// In the cluster: kubectl exec -n urumi deploy/platform -- node src/cli.ts <command>
//   users list | users add <email> <admin|member> [password]
//   keys list [email] | keys create <email> <name> | keys revoke <id|prefix>
//   upstreams list | upstreams enable|disable|remove <prefix>
//   upstreams add <prefix> <name> <url> [none|bearer|header] [credential] [headerName]
//   permissions list | permissions allow|deny <prefix> <tool|*>   (what members may use)
//   audit [limit]
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { createCredentialCipher } from './lib/crypto.ts';
import { listAudit } from './services/audit.ts';
import { listRules, setMemberRule } from './services/permissions.ts';
import { recordActivity, type Action } from './services/activity.ts';
import { assertUrlAllowed, policyFromEnv } from './lib/ssrf.ts';
import { createApiKey, listApiKeys, revokeApiKey } from './services/keys.ts';
import { createUpstream, deleteUpstream, listUpstreams, publicUpstream, updateUpstream, type AuthType } from './services/upstreams.ts';
import { createUser, findUserByEmail, findUserById, listUsers, publicUser, type Role } from './services/users.ts';

const [area, cmd, ...args] = process.argv.slice(2);
const { pool, db } = createDb();
const cipher = createCredentialCipher(loadConfig().encryptionSecret);
const out = (v: unknown) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const die = (m: string): never => { console.error(m); process.exitCode = 1; throw new Error(m); };
// Changes made here are recorded too, with actor "cli" (someone with kubectl exec rights).
const note = (action: Action, target: string, detail?: Record<string, unknown>) => recordActivity(db, { id: null, email: 'cli' }, action, target, detail);
const user = async (email: string) => (await findUserByEmail(db, email)) ?? die(`no user ${email}`);

try {
  const key = area === 'audit' ? 'audit' : `${area} ${cmd ?? ''}`.trim();
  switch (key) {
    case 'users list': out((await listUsers(db)).map(publicUser)); break;
    case 'users add': {
      const [email, role, password] = args;
      if (!email || (role !== 'admin' && role !== 'member')) die('usage: users add <email> <admin|member> [password]');
      out(publicUser(await createUser(db, { email, role: role as Role, password })));
      await note('user_created', email!, { role });
      break;
    }
    case 'keys list': out(await listApiKeys(db, args[0] ? (await user(args[0])).id : undefined)); break;
    case 'keys create': {
      const [email, name] = args;
      if (!email || !name) die('usage: keys create <email> <name>');
      const { key: k, row } = await createApiKey(db, (await user(email)).id, name);
      out({ id: row.id, prefix: row.prefix, user: email, key: k, note: 'shown once; store it now' });
      await note('key_created', email!, { prefix: row.prefix, name: row.name });
      break;
    }
    case 'keys revoke': {
      const row = (await revokeApiKey(db, args[0] ?? die('usage: keys revoke <id|prefix>'))) ?? die('no active key matches');
      out(row); await note('key_revoked', (await findUserById(db, row.userId))?.email ?? row.userId, { prefix: row.prefix, name: row.name });
      break;
    }
    case 'upstreams list': out((await listUpstreams(db)).map(publicUpstream)); break;
    case 'upstreams enable':
    case 'upstreams disable':
      out(publicUpstream((await updateUpstream(db, cipher, args[0] ?? die('prefix required'), { enabled: cmd === 'enable' })) ?? die('no such upstream')));
      await note(cmd === 'enable' ? 'server_enabled' : 'server_disabled', args[0]!);
      break;
    case 'upstreams remove': { const removed = await deleteUpstream(db, args[0] ?? die('prefix required')); out({ removed }); if (removed) await note('server_removed', args[0]!); break; }
    case 'upstreams add': {
      const [prefix, name, url, authType = 'none', credential, authHeaderName] = args;
      if (!prefix || !name || !url) die('usage: upstreams add <prefix> <name> <url> [none|bearer|header] [credential] [headerName]');
      await assertUrlAllowed(url!, policyFromEnv());
      const row = await createUpstream(db, cipher, { prefix, name, url, authType: authType as AuthType, credential, authHeaderName });
      out(publicUpstream(row)); await note('server_added', row.prefix, { name, url, authType, credential: credential ? 'set' : 'none' });
      break;
    }
    case 'permissions list': out(await listRules(db)); break;
    case 'permissions allow':
    case 'permissions deny': {
      const [prefix, tool] = args;
      if (!prefix || !tool) die('usage: permissions allow|deny <prefix> <tool|*>');
      await setMemberRule(db, prefix!, tool!, cmd === 'allow', null);
      await note('permission_changed', prefix!, { tool, memberAllowed: cmd === 'allow' });
      out(await listRules(db));
      break;
    }
    case 'audit': out(await listAudit(db, { limit: Number(cmd ?? 20) })); break;
    default: die('commands: users list|add, keys list|create|revoke, upstreams list|add|enable|disable|remove, permissions list|allow|deny, audit [limit]');
  }
} catch (e) {
  if (!process.exitCode) { console.error((e as Error).message); process.exitCode = 1; }
} finally {
  await pool.end();
}
