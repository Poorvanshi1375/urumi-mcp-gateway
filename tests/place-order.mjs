// Place a cash-on-delivery order through the WooCommerce Store API: the same endpoints the
// storefront's checkout page uses (cart -> add item -> checkout). No credentials needed.
// Usage: STORE_URL=http://store.localhost:9080 node tests/place-order.mjs [product name part]
// Prints the order id. Used by scripts/verify-dod.sh when the store has no orders yet.
const STORE = (process.env.STORE_URL ?? 'http://store.localhost:9080').replace(/\/$/, '');
const want = (process.argv[2] ?? 'mug').toLowerCase();
const api = `${STORE}/wp-json/wc/store/v1`;
let nonce = '', cartToken = '';
async function call(method, path, body) {
  const r = await fetch(api + path, {
    method,
    headers: { 'content-type': 'application/json', ...(nonce ? { nonce } : {}), ...(cartToken ? { 'cart-token': cartToken } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  nonce = r.headers.get('nonce') ?? nonce;
  cartToken = r.headers.get('cart-token') ?? cartToken;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
const products = await call('GET', '/products?per_page=20');
const product = products.find(p => p.name.toLowerCase().includes(want)) ?? products[0];
if (!product) throw new Error('the store has no products');
await call('GET', '/cart');
await call('POST', '/cart/add-item', { id: product.id, quantity: 1 });
const address = { first_name: 'Verify', last_name: 'Bot', address_1: '12 MG Road', city: 'Bengaluru', state: 'KA', postcode: '560001', country: 'IN', phone: '9876543210' };
const order = await call('POST', '/checkout', { billing_address: { ...address, email: 'verify-bot@example.com' }, shipping_address: address, payment_method: 'cod' });
console.log(`order ${order.order_id} placed: ${product.name}, status ${order.status}, payment ${order.payment_result?.payment_status}`);
