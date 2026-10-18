CREATE TABLE "tool_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upstream_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"hash" text NOT NULL,
	"definition" jsonb NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	CONSTRAINT "tool_pins_upstream_tool_unique" UNIQUE("upstream_id","tool")
);
--> statement-breakpoint
ALTER TABLE "tool_pins" ADD CONSTRAINT "tool_pins_upstream_id_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."upstreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_pins" ADD CONSTRAINT "tool_pins_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;