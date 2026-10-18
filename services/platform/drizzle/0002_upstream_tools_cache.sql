ALTER TABLE "upstreams" ADD COLUMN "tools_cache" jsonb;--> statement-breakpoint
ALTER TABLE "upstreams" ADD COLUMN "tools_cached_at" timestamp with time zone;