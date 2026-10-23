// Local versus production, proved from the charts: renders each chart with values-local.yaml and
// values-prod.yaml and prints every field that differs, by object and field path. The brief asks
// for "the same Helm charts, configuration changes only"; this shows exactly which configuration.
// It fails if a difference falls outside the expected kinds (hosts and ports, TLS, scaling, storage,
// resources, health interval), so a template that behaves differently per environment is caught.
// Run: node scripts/values-diff.mjs            (needs helm)
//      node scripts/values-diff.mjs --markdown (the table for docs/SYSTEM_DESIGN.md)
import { render } from './chart-invariants.mjs';

const PROD_SET = {
  'urumi-store': ['--set', 'store.host=store.203.0.113.10.nip.io', '--set', 'store.homeUrl=https://store.203.0.113.10.nip.io'],
  'urumi-platform': ['--set', 'platform.ingress.host=app.203.0.113.10.nip.io', '--set', 'wooMcp.store.signingBaseUrl=http://store.203.0.113.10.nip.io'],
};
const IMAGES = ['--set', 'image.tag=check', '--set', 'wooMcp.image.tag=check', '--set', 'shipMcp.image.tag=check', '--set', 'provisioner.image.tag=check'];

// What may differ between environments, by field path (object id + path). Anything else fails.
const EXPECTED = [
  [/\.(host|hosts\.\d+)$|\.env\.(WP_HOME_URL|WC_SIGNING_BASE_URL|WORDPRESS_CONFIG_EXTRA|PUBLIC_URL|SSRF_DENY_HOSTS|STORE_HOME_URL_TEMPLATE|STORE_SIGNING_URL_TEMPLATE|STORE_BASE_HOST)\.value$/, 'hosts and URLs'],
  [/\.env\.STORE_MAX\.value$/, 'how many bonus stores the node can hold'],
  [/^Service\/store-wordpress\.spec\.ports\.http-\d+\./, "the home URL's port on the store Service (local :9080)"],
  // The same port for bonus stores: the only extra store values per environment.
  [/\.env\.STORE_EXTRA_VALUES\.value$/, "the home URL's port on the store Service (local :9080)"],
  [/\.env\.UPSTREAM_HEALTH_INTERVAL_MS\.value$/, 'health-check interval'],
  [/\.tls\b|cert-manager|Middleware\/|router\.middlewares|redirect/, 'TLS and the http to https redirect'],
  [/\.replicas$|HorizontalPodAutoscaler\/|PodDisruptionBudget\//, 'replicas and autoscaling'],
  [/storage|storageClassName/, 'storage'],
  [/\.resources\./, 'resources'],
];

const flatten = (v, path, out) => {
  if (v && typeof v === 'object') {
    // Env lists: key by variable name so a reordering is not a difference.
    if (Array.isArray(v) && v.every(e => e && typeof e === 'object' && 'name' in e)) for (const e of v) flatten(e, `${path}.${e.name}`, out);
    else for (const [k, x] of Object.entries(v)) flatten(x, `${path}.${k}`, out);
  } else out.set(path, v);
  return out;
};
const objects = docs => new Map(docs.map(d => [`${d.kind}/${d.metadata.name}`, d]));

const rows = [];
let unexpected = 0;
for (const chart of ['urumi-store', 'urumi-platform']) {
  const extra = chart === 'urumi-platform' ? IMAGES : [];
  const local = objects(render({ chart, values: 'values-local.yaml', set: extra }));
  const prod = objects(render({ chart, values: 'values-prod.yaml', set: [...extra, ...PROD_SET[chart]] }));
  for (const id of new Set([...local.keys(), ...prod.keys()])) {
    const a = local.has(id) ? flatten(local.get(id), id, new Map()) : new Map();
    const b = prod.has(id) ? flatten(prod.get(id), id, new Map()) : new Map();
    // A whole object present in one environment only is one row.
    if (!local.has(id) || !prod.has(id)) { rows.push({ chart, path: id, local: local.has(id) ? 'present' : 'absent', prod: prod.has(id) ? 'present' : 'absent' }); continue; }
    for (const p of new Set([...a.keys(), ...b.keys()])) {
      if (p.includes('.metadata.labels.helm.sh/chart') || a.get(p) === b.get(p)) continue;
      rows.push({ chart, path: p, local: a.get(p), prod: b.get(p) });
    }
  }
}
for (const r of rows) {
  r.kind = EXPECTED.find(([re]) => re.test(r.path))?.[1];
  if (!r.kind) unexpected++;
}

const show = v => (v === undefined ? '(unset)' : String(v));
// A multi-line value (e.g. PHP config): only the first line that differs.
const firstDiff = (a, b) => {
  const x = show(a).split('\n'), y = show(b).split('\n');
  if (x.length < 2 && y.length < 2) return [x[0], y[0]];
  const i = x.findIndex((l, n) => l !== y[n]);
  return [`… ${x[i] ?? ''}`, `… ${y[i] ?? ''}`];
};
if (process.argv.includes('--markdown')) {
  console.log('| What | Object and field | Local (k3d) | VPS |\n|---|---|---|---|');
  for (const r of rows) {
    const [l, p] = firstDiff(r.local, r.prod);
    console.log(`| ${r.kind ?? '**unexpected**'} | \`${r.path.replace(/\.spec\.template\.spec\.containers\./, '…')}\` | ${l.replace(/\|/g, '\\|')} | ${p.replace(/\|/g, '\\|')} |`);
  }
} else {
  for (const r of rows) console.log(`${r.kind ? '    ' : 'UNEX'}  ${r.chart.padEnd(15)} ${r.path}\n        local: ${show(r.local)}\n        prod:  ${show(r.prod)}`);
  console.log(`${rows.length} differences, ${unexpected} outside the expected kinds`);
  console.log(unexpected ? 'VALUES DIFF FAILED' : 'VALUES DIFF PASSED');
}
process.exit(unexpected ? 1 : 0);
