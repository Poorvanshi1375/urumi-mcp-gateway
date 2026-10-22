// Container image references for hosted MCP servers (AF): normalised the way containerd resolves
// them, then checked against the admin's allowlist of prefixes. The API checks at create time and
// the provisioner checks again before every deploy, since the allowlist may change in between.
export type ImageRef = { registry: string; repository: string; tag: string | null; digest: string | null; full: string };

export class ImageRefError extends Error {}

const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;   // one path component (OCI distribution spec)
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REGISTRY = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d{1,5})?$|^[a-z0-9-]+:\d{1,5}$/;

// "foo" -> docker.io/library/foo, "user/foo" -> docker.io/user/foo; a first component with a dot
// or a port, or "localhost", is a registry. A tag or a digest is required and ":latest" is refused,
// so what runs is what the admin chose and does not change under them.
export function parseImage(input: string): ImageRef {
  const ref = input.trim();
  if (!ref || ref.length > 255) throw new ImageRefError('image reference is empty or too long');
  let rest = ref, digest: string | null = null, tag: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) { digest = rest.slice(at + 1); rest = rest.slice(0, at); if (!DIGEST.test(digest)) throw new ImageRefError(`invalid digest "${digest}" (expected sha256:<64 hex>)`); }
  const slash = rest.lastIndexOf('/'), colon = rest.lastIndexOf(':');
  if (colon > slash) { tag = rest.slice(colon + 1); rest = rest.slice(0, colon); if (!TAG.test(tag)) throw new ImageRefError(`invalid tag "${tag}"`); }
  const parts = rest.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    registry = parts.shift()!;
    const port = Number(/:(\d+)$/.exec(registry)?.[1] ?? 1);
    if (!REGISTRY.test(registry) || port < 1 || port > 65535) throw new ImageRefError(`invalid registry "${registry}"`);
  }
  if (registry === 'index.docker.io') registry = 'docker.io';
  if (registry === 'docker.io' && parts.length === 1) parts.unshift('library');
  if (!parts.length || !parts.every(p => COMPONENT.test(p))) throw new ImageRefError(`invalid repository "${parts.join('/')}" (lowercase letters, digits, . _ -)`);
  if (!tag && !digest) throw new ImageRefError('the image needs a tag or a digest (for example :1.2.0 or @sha256:...)');
  if (tag === 'latest' && !digest) throw new ImageRefError('":latest" is refused: pin a version tag or a digest');
  const repository = parts.join('/');
  return { registry, repository, tag, digest, full: `${registry}/${repository}${tag ? `:${tag}` : ''}${digest ? `@${digest}` : ''}` };
}

// An allowlist entry is a prefix of "<registry>/<repository>": a whole namespace ("docker.io/mcp/")
// or a name prefix ("docker.io/library/urumi-"). It must name the registry and at least the start
// of a repository, so "docker.io" alone (which would also match "docker.io.evil.com/...") is
// refused when the configuration is loaded.
export function checkAllowPrefixes(prefixes: string[]): string[] {
  return prefixes.map(p => {
    const v = p.trim().toLowerCase();
    if (!/^[a-z0-9.-]+(:\d{1,5})?\/[a-z0-9._/-]+$/.test(v)) throw new Error(`invalid image allowlist entry "${p}": use <registry>/<path prefix>, e.g. docker.io/mcp/`);
    return v;
  });
}

export function imageAllowed(ref: ImageRef, prefixes: string[]): boolean {
  const name = `${ref.registry}/${ref.repository}`;
  return prefixes.some(p => name.startsWith(p));
}

// Both checks, with the reason for the admin.
export function checkImage(input: string, prefixes: string[]): ImageRef {
  const ref = parseImage(input);
  if (!imageAllowed(ref, prefixes)) throw new ImageRefError(`${ref.registry}/${ref.repository} is not allowed; allowed prefixes: ${prefixes.join(', ') || '(none)'}`);
  return ref;
}
