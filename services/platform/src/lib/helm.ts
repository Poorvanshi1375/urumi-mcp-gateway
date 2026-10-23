// Helm for the provisioner (bonus stores install the urumi-store chart). Run with an argument array,
// never a shell; with a timeout; output capped. Values go in a private file that is removed after the
// call, so they never appear on a command line. Uses the pod's service account (in-cluster config).
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class HelmError extends Error {}
export type Helm = (args: string[], values?: Record<string, unknown>) => Promise<string>;

export function createHelm(o: { bin?: string; timeoutMs?: number } = {}): Helm {
  return async (args, values) => {
    let dir: string | undefined;
    try {
      const extra: string[] = [];
      if (values) {
        dir = await mkdtemp(join(tmpdir(), 'helm-'));
        const file = join(dir, 'values.json');
        await writeFile(file, JSON.stringify(values), { mode: 0o600 });
        extra.push('-f', file);
      }
      return await new Promise<string>((resolve, reject) => {
        execFile(o.bin ?? 'helm', [...args, ...extra], { timeout: o.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) reject(new HelmError(`helm ${args[0]} failed: ${(String(stderr || err.message).trim().split('\n').filter(Boolean).at(-1) ?? '').slice(0, 300)}`));
          else resolve(stdout);
        });
      });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  };
}
