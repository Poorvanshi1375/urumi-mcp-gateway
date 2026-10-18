-- Custom migration (drizzle-kit generate --custom): the default policy for the WooCommerce server.
-- Members may read products and orders; only admins may create products or change order status.
-- Runs once, so an admin's later changes to these rules are never undone by an upgrade.
INSERT INTO "tool_permissions" ("role", "server_prefix", "tool", "allowed") VALUES
  ('member', 'woo', 'create_product', false),
  ('member', 'woo', 'update_order_status', false)
ON CONFLICT ("role", "server_prefix", "tool") DO NOTHING;
