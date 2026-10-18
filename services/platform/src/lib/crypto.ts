// Secrets handling: API keys, password hashes and encryption of upstream credentials at rest.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// API keys: "urk_" + 43 chars of base64url (256 random bits). Only the SHA-256 is stored; a
// high-entropy key needs no slow hash. The first 12 chars ("urk_" + 8) are a display/audit prefix.
const KEY_RE = /^urk_[A-Za-z0-9_-]{43}$/;
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `urk_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}
export const looksLikeApiKey = (s: string) => KEY_RE.test(s);
export const apiKeyPrefix = (s: string) => (looksLikeApiKey(s) ? s.slice(0, 12) : null);

// Passwords: scrypt with a random salt, stored as "scrypt$N$r$p$salt$hash" (base64url parts).
const SCRYPT = { N: 16384, r: 8, p: 1 };
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = stored?.split('$');
  if (!parts || parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const got = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(got, expected);
}

// Upstream credentials: AES-256-GCM, stored as "v1:iv:tag:ciphertext" (base64url parts).
export function createCredentialCipher(secret: string) {
  const key = createHash('sha256').update(`urumi-credentials:${secret}`).digest();
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
    },
    decrypt(stored: string): string {
      const [v, iv, tag, ct] = stored.split(':');
      if (v !== 'v1') throw new Error('unknown credential format');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
  };
}
export type CredentialCipher = ReturnType<typeof createCredentialCipher>;
