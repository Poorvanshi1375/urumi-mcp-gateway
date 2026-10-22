CREATE TABLE "hosted_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prefix" text NOT NULL,
	"name" text NOT NULL,
	"image" text NOT NULL,
	"transport" text DEFAULT 'http' NOT NULL,
	"port" integer DEFAULT 8080 NOT NULL,
	"path" text DEFAULT '/mcp' NOT NULL,
	"command" jsonb,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_env_enc" text,
	"size" text DEFAULT 'small' NOT NULL,
	"needs_internet" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'provisioning' NOT NULL,
	"step" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_servers_prefix_unique" UNIQUE("prefix"),
	CONSTRAINT "hosted_servers_prefix_check" CHECK ("hosted_servers"."prefix" ~ '^[a-z0-9]{2,12}$' and "hosted_servers"."prefix" not in ('gateway', 'store', 'mcp')),
	CONSTRAINT "hosted_servers_state_check" CHECK ("hosted_servers"."state" in ('provisioning', 'ready', 'failed', 'deleting')),
	CONSTRAINT "hosted_servers_transport_check" CHECK ("hosted_servers"."transport" in ('http', 'stdio')),
	CONSTRAINT "hosted_servers_port_check" CHECK ("hosted_servers"."port" between 1024 and 65535),
	CONSTRAINT "hosted_servers_path_check" CHECK ("hosted_servers"."path" ~ '^/[A-Za-z0-9._~/-]{0,200}$'),
	CONSTRAINT "hosted_servers_size_check" CHECK ("hosted_servers"."size" in ('small', 'medium', 'large'))
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"host" text NOT NULL,
	"admin_email" text NOT NULL,
	"currency" text NOT NULL,
	"country" text NOT NULL,
	"timezone" text NOT NULL,
	"state" text DEFAULT 'provisioning' NOT NULL,
	"step" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_slug_unique" UNIQUE("slug"),
	CONSTRAINT "stores_host_unique" UNIQUE("host"),
	CONSTRAINT "stores_slug_check" CHECK ("stores"."slug" ~ '^[a-z0-9]{2,12}$' and "stores"."slug" not in ('gateway', 'store', 'mcp')),
	CONSTRAINT "stores_state_check" CHECK ("stores"."state" in ('provisioning', 'ready', 'failed', 'deleting'))
);
--> statement-breakpoint
ALTER TABLE "upstreams" ADD COLUMN "managed_by" text;--> statement-breakpoint
ALTER TABLE "upstreams" ADD COLUMN "managed_id" uuid;--> statement-breakpoint
ALTER TABLE "hosted_servers" ADD CONSTRAINT "hosted_servers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hosted_servers_work_idx" ON "hosted_servers" USING btree ("state","lease_until");--> statement-breakpoint
CREATE INDEX "stores_work_idx" ON "stores" USING btree ("state","lease_until");--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_managed_check" CHECK (("upstreams"."managed_by" is null and "upstreams"."managed_id" is null) or ("upstreams"."managed_by" in ('hosted', 'store') and "upstreams"."managed_id" is not null));