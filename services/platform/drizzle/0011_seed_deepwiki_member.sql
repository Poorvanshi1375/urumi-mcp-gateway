-- Custom migration (drizzle-kit generate --custom). With platform.permissions.memberDefault
-- readOnly, members may use only tools a server marks readOnlyHint: true. DeepWiki's tools carry no
-- annotations, so this explicit rule keeps the documentation server open to members, as before.
-- Runs once; an admin can change it later in the dashboard and an upgrade never undoes that.
INSERT INTO "tool_permissions" ("role", "server_prefix", "tool", "allowed") VALUES
  ('member', 'deepwiki', '*', true)
ON CONFLICT ("role", "server_prefix", "tool") DO NOTHING;
