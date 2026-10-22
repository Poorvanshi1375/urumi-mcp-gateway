// Platform database schema (PostgreSQL). Migrations are generated from this file with
// `npm run db:generate` and committed under drizzle/; never edit generated SQL by hand.
import { sql } from 'drizzle-orm';
import { bigint, bigserial, boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  role: text('role').notNull().default('member'),
  passwordHash: text('password_hash'),
  createdAt: createdAt(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, t => [check('users_role_check', sql`${t.role} in ('admin', 'member')`)]);

// Dashboard sessions; id is the SHA-256 of the cookie token, never the token itself.
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  role: text('role').notNull().default('member'),
  tokenHash: text('token_hash').notNull().unique(),
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
}, t => [check('invites_role_check', sql`${t.role} in ('admin', 'member')`)]);

// Per-user gateway keys: 256-bit random, shown once, stored as SHA-256 (§D.6).
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

// Registered upstream MCP servers. Tools are exposed as `<prefix>__<tool>` (§D.7).
// credentialEnc holds the encrypted header/bearer value; it never leaves the server.
export const upstreams = pgTable('upstreams', {
  id: uuid('id').primaryKey().defaultRandom(),
  prefix: text('prefix').notNull().unique(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  authType: text('auth_type').notNull().default('none'),
  authHeaderName: text('auth_header_name'),
  credentialEnc: text('credential_enc'),
  enabled: boolean('enabled').notNull().default(true),
  // Whether the gateway believes this server's tool annotations (readOnlyHint) for member defaults
  // and chat confirmation (M). Off for servers an admin adds; the release's own servers are trusted
  // at runtime, whatever this says.
  trustAnnotations: boolean('trust_annotations').notNull().default(false),
  // Set for the rows the provisioner registers (T1-2/T1-3): 'hosted' (an admin's container image)
  // or 'store' (a bonus store's own woo-mcp), with the id of that hosted_servers or stores row. Their
  // URL, auth and credential cannot be edited and the row cannot be deleted directly: delete the
  // hosted server or store instead.
  managedBy: text('managed_by'),
  managedId: uuid('managed_id'),
  // Last tool list seen from this upstream, so the dashboard can show a disabled or unreachable
  // server's tools after a gateway restart (G7). Never used to expose tools to clients.
  toolsCache: jsonb('tools_cache'),
  toolsCachedAt: timestamp('tools_cached_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check('upstreams_prefix_check', sql`${t.prefix} ~ '^[a-z0-9]{2,12}$'`),
  check('upstreams_auth_type_check', sql`${t.authType} in ('none', 'bearer', 'header')`),
  check('upstreams_managed_check', sql`(${t.managedBy} is null and ${t.managedId} is null) or (${t.managedBy} in ('hosted', 'store') and ${t.managedId} is not null)`),
]);

// One row per tools/call, and per rejected request (T4). FKs are SET NULL so history survives deletes.
export const auditEvents = pgTable('audit_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  createdAt: createdAt(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
  keyPrefix: text('key_prefix'),
  source: text('source').notNull().default('mcp'),
  upstreamId: uuid('upstream_id').references(() => upstreams.id, { onDelete: 'set null' }),
  serverPrefix: text('server_prefix'),
  tool: text('tool'),
  durationMs: integer('duration_ms'),
  outcome: text('outcome').notNull(),
  error: text('error'),
  // Set when the call came with an OAuth access token instead of an API key.
  oauthGrantId: uuid('oauth_grant_id').references(() => oauthGrants.id, { onDelete: 'set null' }),
  // SHA-256 of the call's arguments (canonical JSON): the same value twice is the same request
  // (e.g. a retried write), without storing what was sent.
  argsSha256: text('args_sha256'),
  // One id per /mcp request or chat message (32 hex, the W3C trace id sent upstream as
  // _meta.traceparent and logged there), so a call can be followed across services.
  requestId: text('request_id'),
}, t => [
  // Dashboard audit views: newest first, overall and per user.
  index('audit_events_created_at_idx').on(t.createdAt.desc()),
  index('audit_events_user_created_at_idx').on(t.userId, t.createdAt.desc()),
  check('audit_events_source_check', sql`${t.source} in ('mcp', 'chat')`),
  // pending: written before the call (write-ahead); unknown: never completed (the sweep sets it);
  // busy: refused because the server already had its maximum of calls in flight.
  check('audit_events_outcome_check', sql`${t.outcome} in ('ok', 'tool_error', 'timeout', 'upstream_unreachable', 'rejected', 'denied', 'busy', 'pending', 'unknown')`),
]);

// Which tools members may use. No row means allowed; tool '*' covers the whole server and an
// exact tool row wins over it. Admins may always use every tool, so only role 'member' is stored.
// `tool` is the upstream's own tool name (stable), not the exposed one. No FK to upstreams: the
// seed rows for "woo" are inserted by a migration, before bootstrap registers the server.
export const toolPermissions = pgTable('tool_permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: text('role').notNull().default('member'),
  serverPrefix: text('server_prefix').notNull(),
  tool: text('tool').notNull(),
  allowed: boolean('allowed').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  unique('tool_permissions_rule_unique').on(t.role, t.serverPrefix, t.tool),
  check('tool_permissions_role_check', sql`${t.role} in ('member')`),
]);

// Per-tool override of when chat asks before running a tool (C): 'always' even if the tool says it
// is read-only, 'never' for a read tool the server does not annotate. No row = automatic (ask unless
// the tool is read-only and its server's hints are trusted). tool '*' covers the whole server.
export const toolConfirmRules = pgTable('tool_confirm_rules', {
  serverPrefix: text('server_prefix').notNull(),
  tool: text('tool').notNull(),
  mode: text('mode').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  unique('tool_confirm_rules_unique').on(t.serverPrefix, t.tool),
  check('tool_confirm_rules_mode_check', sql`${t.mode} in ('always', 'never')`),
]);

// A write the chat agent wants to make, waiting for the user's click (C). Stored server-side so the
// browser cannot change the arguments between proposal and execution: the confirm request carries
// only the id. Decided once; unanswered rows expire.
export const chatProposals = pgTable('chat_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),   // exposed name, <prefix>__<tool>
  args: jsonb('args').notNull(),
  argsSha256: text('args_sha256').notNull(),
  summary: text('summary').notNull(),
  requestId: text('request_id').notNull(),   // the chat message that proposed it
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decision: text('decision'),
  auditId: bigint('audit_id', { mode: 'number' }),   // the audit row of the confirmed call
}, t => [
  index('chat_proposals_user_idx').on(t.userId, t.createdAt),
  check('chat_proposals_decision_check', sql`${t.decision} in ('confirmed', 'rejected', 'expired')`),
]);

// Desired state for the provisioner (T1-2/T1-3), one row per tenant. The dashboard writes the row
// and returns; the provisioner reconciles it (provision/steps.ts) and reports state, step and error
// here. Prefixes and slugs share the upstreams naming rule; "gateway", "store" and "mcp" are
// reserved ("store-store" would be a confusing namespace).
// Work is claimed per row with a lease (lease_owner, lease_until; provision/rows.ts, H1): a crashed
// provisioner's lease simply runs out, and two replicas never work on the same row. Every write by
// the provisioner is a compare-and-set on state (H2): if a Delete arrived meanwhile, the install's
// write matches no row and the install stops.
const provisionState = () => ({
  state: text('state', { enum: ['provisioning', 'ready', 'failed', 'deleting'] }).notNull().default('provisioning'),
  step: text('step'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  leaseOwner: text('lease_owner'),   // the provisioner process working on the row
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
const TENANT_NAME = sql.raw(`'^[a-z0-9]{2,12}$'`);
const RESERVED = sql.raw(`('gateway', 'store', 'mcp')`);
const STATES = sql.raw(`('provisioning', 'ready', 'failed', 'deleting')`);

// A hosted MCP server: an admin's container image, run by the provisioner in its own namespace
// mcp-<prefix> (stand-out 5). Secret env is encrypted like upstream credentials and never returned.
export const hostedServers = pgTable('hosted_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  prefix: text('prefix').notNull().unique(),
  name: text('name').notNull(),
  image: text('image').notNull(),   // normalised (lib/image-ref.ts)
  transport: text('transport').notNull().default('http'),
  port: integer('port').notNull().default(8080),
  path: text('path').notNull().default('/mcp'),
  command: jsonb('command'),   // stdio only: argv
  env: jsonb('env').notNull().default({}),
  secretEnvEnc: text('secret_env_enc'),
  size: text('size').notNull().default('small'),
  needsInternet: boolean('needs_internet').notNull().default(false),
  ...provisionState(),
}, t => [
  check('hosted_servers_prefix_check', sql`${t.prefix} ~ ${TENANT_NAME} and ${t.prefix} not in ${RESERVED}`),
  check('hosted_servers_state_check', sql`${t.state} in ${STATES}`),
  check('hosted_servers_transport_check', sql`${t.transport} in ('http', 'stdio')`),
  check('hosted_servers_port_check', sql`${t.port} between 1024 and 65535`),
  check('hosted_servers_path_check', sql`${t.path} ~ '^/[A-Za-z0-9._~/-]{0,200}$'`),
  check('hosted_servers_size_check', sql`${t.size} in ('small', 'medium', 'large')`),
  index('hosted_servers_work_idx').on(t.state, t.leaseUntil),
]);

// A bonus store: the urumi-store chart in its own namespace store-<slug>, with its own MySQL, a
// generated Secret, an Ingress host, and its own woo-mcp registered as upstream <slug>.
export const stores = pgTable('stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  host: text('host').notNull().unique(),
  adminEmail: text('admin_email').notNull(),
  currency: text('currency').notNull(),
  country: text('country').notNull(),
  timezone: text('timezone').notNull(),
  ...provisionState(),
}, t => [
  check('stores_slug_check', sql`${t.slug} ~ ${TENANT_NAME} and ${t.slug} not in ${RESERVED}`),
  check('stores_state_check', sql`${t.state} in ${STATES}`),
  index('stores_work_idx').on(t.state, t.leaseUntil),
]);

// Admin and account actions (who changed what), separate from tool calls so call statistics stay
// clean. actor_email is a snapshot, kept if the user is later deleted. `detail` never holds a
// secret: for credentials it only says that one was set or changed.
export const activityEvents = pgTable('activity_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  createdAt: createdAt(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  actorEmail: text('actor_email'),
  action: text('action').notNull(),
  target: text('target'),
  detail: jsonb('detail'),
  ip: text('ip'),
}, t => [
  index('activity_events_created_at_idx').on(t.createdAt.desc()),
  index('activity_events_actor_created_at_idx').on(t.actorId, t.createdAt.desc()),
]);

// Tool pinning (behind platform.features.toolPinning): the approved version of each upstream tool,
// as a hash of its title, description and input schema plus the definition itself (for the diff).
// A tool whose current hash differs, or that has no pin on a server that has pins, is hidden from
// clients until an admin approves it. Cascades with the upstream.
export const toolPins = pgTable('tool_pins', {
  id: uuid('id').primaryKey().defaultRandom(),
  upstreamId: uuid('upstream_id').notNull().references(() => upstreams.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
  hash: text('hash').notNull(),
  definition: jsonb('definition').notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [unique('tool_pins_upstream_tool_unique').on(t.upstreamId, t.tool)]);

// Failed sign-ins in the last 15 minutes, per "email:<address>" and "ip:<address>" key. In Postgres
// (not memory) so every gateway replica counts the same attempts. Old rows are pruned on insert.
export const loginFailures = pgTable('login_failures', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  key: text('key').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('login_failures_key_at_idx').on(t.key, t.at)]);

// OAuth on the gateway (stand-out item 3, behind platform.features.oauth). Clients register
// themselves (RFC 7591) and are public: no client secret, PKCE instead. Codes and tokens are
// random and stored only as SHA-256, like API keys.
export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id').notNull().unique(),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

// One grant per approval: a user allowed a client. Revoking it ends every token issued under it.
export const oauthGrants = pgTable('oauth_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientId: uuid('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [index('oauth_grants_user_idx').on(t.userId)]);

// Authorization codes: single use, a few minutes, bound to the client, redirect URI and PKCE challenge.
export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: uuid('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  grantId: uuid('grant_id').references(() => oauthGrants.id, { onDelete: 'cascade' }),
});

// Access tokens (short-lived) and refresh tokens (rotated on every use).
export const oauthTokens = pgTable('oauth_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  grantId: uuid('grant_id').notNull().references(() => oauthGrants.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [
  index('oauth_tokens_grant_idx').on(t.grantId),
  check('oauth_tokens_kind_check', sql`${t.kind} in ('access', 'refresh')`),
]);

// Rate-limit buckets shared by every gateway replica (lib/ratelimit.ts, SharedRateLimiter).
export const rateBuckets = pgTable('rate_buckets', {
  subject: text('subject').primaryKey(),   // e.g. "mcp:key:<id>", "chat:<user id>"
  tokens: doublePrecision('tokens').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

