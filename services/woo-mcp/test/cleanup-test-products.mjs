// Trash draft test products: TEST- SKUs from smoke.mjs, and "TEST chat …" names from chat-check. Runs on the laptop against the k3d
// store (connects to 127.0.0.1, signs over WC_SIGNING_BASE_URL). Only TEST- SKUs are touched.
// Env: WC_CONSUMER_KEY, WC_CONSUMER_SECRET (from Secret store-secrets).
import { createWooClient } from '../src/woo.ts';

const woo = createWooClient({
  signingBaseUrl: process.env.WC_SIGNING_BASE_URL ?? 'http://store.localhost:9080',
  connectHost: process.env.WC_CONNECT_HOST ?? '127.0.0.1',
  consumerKey: process.env.WC_CONSUMER_KEY,
  consumerSecret: process.env.WC_CONSUMER_SECRET,
  timeoutMs: 15000,
});
const { data } = await woo.get('products', { status: 'draft', per_page: 100 });
const victims = data.filter(p => p.sku?.startsWith('TEST-') || /^TEST chat/i.test(p.name));
for (const p of victims) {
  await woo.put(`products/${p.id}`, { status: 'trash' }).catch(() => {});
  console.log(`trashed ${p.id} ${p.sku}`);
}
const all = await woo.get('products', { status: 'any', per_page: 100 });
console.log(`removed ${victims.length}; remaining: ${all.data.map(p => `${p.sku}:${p.status}`).join(', ')}`);
