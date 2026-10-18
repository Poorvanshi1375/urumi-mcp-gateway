// First-start setup, idempotent: create the first admin if there are no users, and register the
// configured upstreams that do not exist yet (Woo first, G8). Existing rows are never overwritten,
// so later admin edits (disable, new credential) survive restarts and upgrades.
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import type { CredentialCipher } from './lib/crypto.ts';
import { createUpstream, findUpstream } from './services/upstreams.ts';
import { countUsers, createUser } from './services/users.ts';

type Logger = { info: (o: object, m: string) => void };

export async function bootstrap(db: Db, cipher: CredentialCipher, cfg: Config['bootstrap'], log: Logger) {
  if (cfg.adminEmail && (await countUsers(db)) === 0) {
    const u = await createUser(db, { email: cfg.adminEmail, name: 'Admin', role: 'admin', password: cfg.adminPassword });
    log.info({ email: u.email }, 'bootstrap: created first admin');
  }
  // Sequential, in config order, so created_at preserves the order (Woo first).
  for (const b of cfg.upstreams) {
    if (await findUpstream(db, b.prefix)) continue;
    const credential = b.credentialEnv ? process.env[b.credentialEnv] : undefined;
    if (b.authType !== 'none' && !credential) throw new Error(`bootstrap upstream ${b.prefix}: env ${b.credentialEnv} is empty`);
    await createUpstream(db, cipher, { ...b, credential });
    log.info({ prefix: b.prefix, url: b.url }, 'bootstrap: registered upstream');
  }
}
