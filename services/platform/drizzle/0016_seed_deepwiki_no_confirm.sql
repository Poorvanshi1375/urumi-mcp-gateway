-- Custom migration (drizzle-kit generate --custom). Chat asks before running any tool that is not
-- read-only from a server whose hints the gateway trusts (C, M). DeepWiki answers documentation
-- questions only, but it is not deployed by this release and sends no readOnlyHint, so every
-- documentation question would ask first. This rule says "never ask" for its tools. Runs once; an
-- admin can change it on the Servers page and an upgrade never undoes that.
INSERT INTO "tool_confirm_rules" ("server_prefix", "tool", "mode") VALUES
  ('deepwiki', '*', 'never')
ON CONFLICT ("server_prefix", "tool") DO NOTHING;
