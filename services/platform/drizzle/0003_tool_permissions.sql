CREATE TABLE "tool_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"server_prefix" text NOT NULL,
	"tool" text NOT NULL,
	"allowed" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "tool_permissions_rule_unique" UNIQUE("role","server_prefix","tool"),
	CONSTRAINT "tool_permissions_role_check" CHECK ("tool_permissions"."role" in ('member'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_outcome_check";--> statement-breakpoint
ALTER TABLE "tool_permissions" ADD CONSTRAINT "tool_permissions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_outcome_check" CHECK ("audit_events"."outcome" in ('ok', 'tool_error', 'timeout', 'upstream_unreachable', 'rejected', 'denied'));