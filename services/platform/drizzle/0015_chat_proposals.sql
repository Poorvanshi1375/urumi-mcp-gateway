CREATE TABLE "chat_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"args_sha256" text NOT NULL,
	"summary" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decision" text,
	"audit_id" bigint,
	CONSTRAINT "chat_proposals_decision_check" CHECK ("chat_proposals"."decision" in ('confirmed', 'rejected', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "tool_confirm_rules" (
	"server_prefix" text NOT NULL,
	"tool" text NOT NULL,
	"mode" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "tool_confirm_rules_unique" UNIQUE("server_prefix","tool"),
	CONSTRAINT "tool_confirm_rules_mode_check" CHECK ("tool_confirm_rules"."mode" in ('always', 'never'))
);
--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_confirm_rules" ADD CONSTRAINT "tool_confirm_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_proposals_user_idx" ON "chat_proposals" USING btree ("user_id","created_at");