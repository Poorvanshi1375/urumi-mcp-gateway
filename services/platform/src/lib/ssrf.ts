// SSRF guard for admin-entered upstream URLs (stand-out item 6). An admin can register any URL, and
// the gateway then connects to it from inside the cluster, so a URL must not reach:
//   - addresses that are never an MCP server: loopback, unspecified, link-local (cloud metadata at
//     169.254.169.254 and fd00:ec2::254), multicast and reserved ranges -> always blocked;
//   - internal networks (RFC 1918, CGNAT, IPv6 unique-local; the pod and Service CIDRs are in
//     them) -> only for hosts or CIDRs allowlisted in the Helm values (our own MCP servers).
// The check runs when a URL is registered (clear error for the admin) and again inside the DNS
// lookup of every connection the gateway makes, on the exact addresses it is about to connect to,
// so a name that later resolves somewhere else (DNS rebinding) is refused too.
import dns from 'node:dns';
import net from 'node:net';
import { Agent, Response as UndiciResponse, fetch as undiciFetch } from 'undici';

// denyHosts / denyCidrs: this platform's own names and public address. Checked first, so a deny always
// wins: a public address can still be us, and the gateway must never be pointed at itself (it would
// list and call its own tools with a stored credential) or at the store through the front door.
export type SsrfPolicy = { allowHosts: string[]; allowCidrs: net.BlockList; denyHosts: string[]; denyCidrs: net.BlockList; disabled: boolean };

const ALWAYS: [string, string, number, 'ipv4' | 'ipv6'][] = [
  ['unspecified', '0.0.0.0', 8, 'ipv4'], ['loopback', '127.0.0.0', 8, 'ipv4'],
  ['link-local (includes cloud metadata)', '169.254.0.0', 16, 'ipv4'], ['multicast', '224.0.0.0', 4, 'ipv4'],
  ['reserved', '240.0.0.0', 4, 'ipv4'],
  ['unspecified', '::', 128, 'ipv6'], ['loopback', '::1', 128, 'ipv6'], ['cloud metadata', 'fd00:ec2::254', 128, 'ipv6'],
  ['link-local', 'fe80::', 10, 'ipv6'], ['multicast', 'ff00::', 8, 'ipv6'],
];
const INTERNAL: [string, number, 'ipv4' | 'ipv6'][] = [
  ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['fc00::', 7, 'ipv6'],
];
const internal = new net.BlockList();
for (const [a, p, t] of INTERNAL) internal.addSubnet(a, p, t);

export class SsrfError extends Error {
  code = 'ESSRF';
}

// Expand an IPv6 address to 8 groups of 16 bits.
function groups(ip: string): number[] {
  let s = ip.toLowerCase();
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split('.').map(Number) as [number, number, number, number];
    s = s.slice(0, -dotted[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map(x => parseInt(x || '0', 16));
}

// An IPv6 address that carries an IPv4 address (IPv4-mapped ::ffff:0:0/96, NAT64 64:ff9b::/96)
// is judged by that IPv4 address.
function embeddedV4(ip: string): string | null {
  const g = groups(ip);
  const v4 = () => `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return v4();
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4();
  return null;
}

// "blocked: <why>" for addresses that are never allowed, "internal", or "public".
export function classify(ip: string): { kind: 'blocked'; why: string } | { kind: 'internal' } | { kind: 'public' } {
  const family = net.isIP(ip);
  if (!family) return { kind: 'blocked', why: 'not an IP address' };
  if (family === 6) { const v4 = embeddedV4(ip); if (v4) return classify(v4); }
  const type = family === 4 ? 'ipv4' : 'ipv6';
  for (const [why, a, p, t] of ALWAYS) {
    if (t !== type) continue;
    const one = new net.BlockList(); one.addSubnet(a, p, t);
    if (one.check(ip, type)) return { kind: 'blocked', why };
  }
  return internal.check(ip, type) ? { kind: 'internal' } : { kind: 'public' };
}

const hostAllowed = (host: string, allow: string[]) =>
  allow.some(a => (a.startsWith('*.') ? host.endsWith(a.slice(1)) : host === a));

// Refused by name, before any DNS lookup.
export function checkHostName(host: string, policy: SsrfPolicy) {
  if (policy.disabled) return;
  if (hostAllowed(bare(host).toLowerCase(), policy.denyHosts)) {
    throw new SsrfError(`blocked by the SSRF guard: ${host} is this platform's own address (the gateway would call itself)`);
  }
}

export function checkAddress(host: string, ip: string, policy: SsrfPolicy) {
  if (policy.disabled) return;
  checkHostName(host, policy);
  if (policy.denyCidrs.check(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4')) {
    throw new SsrfError(`blocked by the SSRF guard: ${host} -> ${ip} is this platform's own address (the gateway would call itself)`);
  }
  const c = classify(ip);
  if (c.kind === 'blocked') throw new SsrfError(`blocked by the SSRF guard: ${host} -> ${ip} is ${c.why}`);
  if (c.kind === 'internal' && !hostAllowed(host.toLowerCase(), policy.allowHosts) && !policy.allowCidrs.check(ip, net.isIP(ip) === 4 ? 'ipv4' : 'ipv6')) {
    throw new SsrfError(`blocked by the SSRF guard: ${host} -> ${ip} is an internal address and ${host} is not on the allowlist`);
  }
}

const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, '');

// Registration-time check: scheme, then every address the host resolves to.
export async function assertUrlAllowed(url: string, policy: SsrfPolicy): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError('url must be http(s)');
  const host = bare(u.hostname);
  if (net.isIP(host)) return checkAddress(host, host, policy);
  checkHostName(host, policy);
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch (e) {
    throw new SsrfError(`cannot resolve ${host} (${(e as NodeJS.ErrnoException).code ?? 'DNS error'})`);
  }
  for (const a of addrs) checkAddress(host, a.address, policy);
}

// A fetch for upstream connections. Its DNS lookup checks every address before the socket
// connects; IP-literal URLs never reach a lookup, so they are checked here first.
// An upstream answer bigger than maxResponseBytes is refused while it streams, before the MCP SDK
// buffers and parses it: capResult() works on the parsed result, too late to protect memory. POST
// responses only (requests and their direct replies, i.e. every tools/list and tools/call); a
// long-lived GET notification stream is not a single answer and is not counted.
export class ResponseTooLargeError extends Error {
  code = 'ERESPONSETOOLARGE';
}
// The SDK reports a streamed answer's error only as text ("SSE stream disconnected: Error: <ours>"),
// so callers recognise it by this marker as well as by the code.
export const TOO_LARGE_MARKER = "the server's response is over";
function capBody(res: UndiciResponse, max: number): UndiciResponse {
  const tooBig = () => new ResponseTooLargeError(`${TOO_LARGE_MARKER} ${max} bytes; reading stopped`);
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (declared > max) { void res.body?.cancel().catch(() => {}); throw tooBig(); }
  if (!res.body) return res;
  let seen = 0;
  // (undici's stream types and the DOM's differ only in typing; the runtime objects are the same.)
  const counted = (res.body as any).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      seen += chunk.byteLength;
      if (seen > max) ctl.error(tooBig()); else ctl.enqueue(chunk);
    },
  }));
  return new UndiciResponse(counted as any, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export function createGuardedFetch(policy: SsrfPolicy, opts: { maxResponseBytes?: number } = {}): typeof fetch {
  const lookup: net.LookupFunction = (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return (callback as any)(err);
      try {
        for (const a of addrs) checkAddress(hostname, a.address, policy);
      } catch (e) {
        return (callback as any)(e);
      }
      if ((options as dns.LookupOptions).all) return (callback as any)(null, addrs);
      (callback as any)(null, addrs[0]!.address, addrs[0]!.family);
    });
  };
  // Short keep-alive: upstreams (Fastify) advertise Keep-Alive: timeout=72, and undici would keep
  // idle sockets that long. If the upstream pod is deleted, packets to its old IP are dropped and a
  // reused socket hangs until the health-check timeout (seen on the VPS: ~30 s to notice a dead
  // server). With idle sockets closed after a few seconds, each health check opens a fresh
  // connection, which a Service without pods refuses at once. Connects give up after 3 s.
  const agent = new Agent({ connect: { lookup, timeout: 3000 }, keepAliveTimeout: 2000, keepAliveMaxTimeout: 5000 });
  // Redirects are never followed here. On a cross-origin redirect fetch drops only Authorization,
  // so a credential in a custom header (X-API-Key) would go to whatever host the upstream names.
  // The MCP SDK already asks for "manual" and follows same-origin redirects itself; forcing it here
  // keeps that true for any other caller and any future SDK default.
  return (async (input: any, init?: any) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const host = bare(u.hostname);
    if (net.isIP(host)) checkAddress(host, host, policy);
    const res = await undiciFetch(input, { ...init, redirect: init?.redirect === 'error' ? 'error' : 'manual', dispatcher: agent });
    const post = String(init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase() === 'POST';
    return opts.maxResponseBytes && post ? capBody(res, opts.maxResponseBytes) : res;
  }) as unknown as typeof fetch;
}

// The one in-cluster host a managed upstream (a hosted server or a bonus store, registered by the
// provisioner) may reach in addition to the policy: the Service "mcp" in its own tenant namespace,
// mcp-<prefix> or store-<slug>. It is added per upstream, never to the global allowlist, so a server
// an admin registers by URL can never point at a tenant namespace, one tenant can never reach
// another's, and the deny lists still apply first. The gateway's NetworkPolicy matches: it reaches
// only the MCP pod in a managed namespace.
export function managedHost(row: { prefix: string; managedBy?: string | null }): string | null {
  if ((row.managedBy !== 'hosted' && row.managedBy !== 'store') || !/^[a-z0-9]{2,12}$/.test(row.prefix)) return null;
  return `mcp.${row.managedBy === 'hosted' ? 'mcp' : 'store'}-${row.prefix}.svc.cluster.local`;
}
export function policyForUpstream(policy: SsrfPolicy, row: { prefix: string; managedBy?: string | null }): SsrfPolicy {
  const host = managedHost(row);
  return host ? { ...policy, allowHosts: [...policy.allowHosts, host] } : policy;
}

// A malformed entry stops the gateway at start: a security list that is silently ignored is worse
// than one that is refused. A bare address means /32 or /128.
function cidrList(name: string, value: string | undefined): net.BlockList {
  const out = new net.BlockList();
  for (const c of (value ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [a = '', p] = c.split('/');
    const family = net.isIP(a);
    const bits = p === undefined ? (family === 6 ? 128 : 32) : Number(p);
    if (!family || !/^\d+$/.test(p ?? String(bits)) || bits > (family === 6 ? 128 : 32)) throw new Error(`${name}: "${c}" is not an IP address or CIDR`);
    out.addSubnet(a, bits, family === 6 ? 'ipv6' : 'ipv4');
  }
  return out;
}

export function policyFromEnv(env = process.env): SsrfPolicy {
  const list = (v?: string) => (v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  // SSRF_GUARD=off is for running the gateway on a laptop against port-forwarded servers only.
  return {
    allowHosts: list(env.SSRF_ALLOW_HOSTS), allowCidrs: cidrList('SSRF_ALLOW_CIDRS', env.SSRF_ALLOW_CIDRS),
    denyHosts: list(env.SSRF_DENY_HOSTS), denyCidrs: cidrList('SSRF_DENY_CIDRS', env.SSRF_DENY_CIDRS),
    disabled: env.SSRF_GUARD === 'off',
  };
}
