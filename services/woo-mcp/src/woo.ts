// WooCommerce REST v3 client for in-cluster use (KT §D.4, verified in Gate V2).
// Woo verifies OAuth 1.0a signatures over the WordPress home URL, never the Host header, so
// requests are signed with WC_SIGNING_BASE_URL (e.g. http://store.localhost:9080) while a custom
// DNS lookup sends the connection to the store's Service (WC_CONNECT_HOST).
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import pkg from '@woocommerce/woocommerce-rest-api';

const WooCommerceRestApi = pkg.default ?? pkg;

export type WooConfig = {
  signingBaseUrl: string;
  connectHost?: string;
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
};

export type WooApi = {
  // The raw axios response: list endpoints also send X-WP-Total and X-WP-TotalPages.
  get(path: string, params?: Record<string, unknown>): Promise<{ status: number; data: any; headers?: Record<string, unknown> }>;
  post(path: string, body: Record<string, unknown>): Promise<{ status: number; data: any }>;
  put(path: string, body: Record<string, unknown>): Promise<{ status: number; data: any }>;
  // The public WordPress REST index (site name, timezone): not under wc/v3, so not signed.
  siteIndex(): Promise<{ name?: string; home?: string; url?: string; timezone_string?: string; gmt_offset?: number | string }>;
};

// The site index fields used (the index is large): the store's name and home URL (AS), and its
// timezone. Real WordPress returns only these, so a missing one here is missing in every result.
export const SITE_FIELDS = 'name,home,timezone_string,gmt_offset';

export function createWooClient(cfg: WooConfig): WooApi {
  const signingHost = new URL(cfg.signingBaseUrl).hostname;
  const lookup: any = (host: string, opts: any, cb: any) =>
    dns.lookup(cfg.connectHost && host === signingHost ? cfg.connectHost : host, opts, cb);
  // No keep-alive: Apache closes idle connections after 5 s, and a request that reuses a socket at
  // that moment fails with ECONNRESET ("socket hang up"), seen on a fresh install. A new connection
  // inside the cluster costs well under a millisecond.
  const agentOpts = { keepAlive: false, lookup };
  const api = new WooCommerceRestApi({
    url: cfg.signingBaseUrl,
    consumerKey: cfg.consumerKey,
    consumerSecret: cfg.consumerSecret,
    version: 'wc/v3',
    axiosConfig: {
      httpAgent: new http.Agent(agentOpts),
      httpsAgent: new https.Agent(agentOpts),
      proxy: false,
      timeout: cfg.timeoutMs,
    },
  });
  // The client signs and sends every param key, turning undefined into the string "undefined"
  // (e.g. sku=undefined matches nothing), so optional params are dropped here.
  const defined = (params: Record<string, unknown> = {}) =>
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  const site = new URL(`wp-json/?_fields=${SITE_FIELDS}`, cfg.signingBaseUrl.replace(/\/?$/, '/'));
  const siteIndex = () => new Promise<any>((resolve, reject) => {
    const mod = site.protocol === 'https:' ? https : http;
    const req = mod.get(site, { agent: new mod.Agent(agentOpts), timeout: cfg.timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', c => { body += c; }).on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error(`site index: HTTP ${res.statusCode}`), { code: 'ESITEINDEX' }));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('site index: not JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))).on('error', reject);
  });
  return {
    get: (path, params) => api.get(path, defined(params)),
    post: (path, body) => api.post(path, body),
    put: (path, body) => api.put(path, body),
    siteIndex,
  };
}

// A failure the tool explains itself (e.g. a SKU conflict); its message is shown as it is.
export class ToolError extends Error {}

// Turn axios/Woo failures into one short, safe line (no credentials, no signed URLs).
export function describeWooError(err: any): string {
  if (err instanceof ToolError) return err.message;
  const r = err?.response;
  if (r) {
    const msg = r.data?.message ?? r.statusText ?? 'request failed';
    const code = r.data?.code ? ` (${r.data.code})` : '';
    return `WooCommerce returned HTTP ${r.status}: ${msg}${code}`;
  }
  if (err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message ?? '')) return 'WooCommerce request timed out';
  const code = err?.code ?? err?.cause?.code;
  return `WooCommerce unreachable${code ? ` (${code})` : ''}: ${err?.message ?? String(err)}`;
}
