// Platform database schema (PostgreSQL). Migrations are generated from this file with
// `npm run db:generate` and committed under drizzle/; never edit generated SQL by hand.
import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

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
  // Last tool list seen from this upstream, so the dashboard can show a disabled or unreachable
  // server's tools after a gateway restart (G7). Never used to expose tools to clients.
  toolsCache: jsonb('tools_cache'),
  toolsCachedAt: timestamp('tools_cached_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check('upstreams_prefix_check', sql`${t.prefix} ~ '^[a-z0-9]{2,12}$'`),
  check('upstreams_auth_type_check', sql`${t.authType} in ('none', 'bearer', 'header')`),
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
}, t => [
  // Dashboard audit views: newest first, overall and per user.
  index('audit_events_created_at_idx').on(t.createdAt.desc()),
  index('audit_events_user_created_at_idx').on(t.userId, t.createdAt.desc()),
  check('audit_events_source_check', sql`${t.source} in ('mcp', 'chat')`),
  check('audit_events_outcome_check', sql`${t.outcome} in ('ok', 'tool_error', 'timeout', 'upstream_unreachable', 'rejected', 'denied')`),
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
