CREATE TABLE IF NOT EXISTS "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"duration_minutes" integer NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "services_provider_id_idx" ON "services" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "services_provider_active_idx" ON "services" USING btree ("provider_id","active");--> statement-breakpoint
-- drizzle-kit 0.24.2 does not emit CHECK constraints from pg-core's
-- check() builder (confirmed absent from meta/0004_snapshot.json even
-- though schema.ts declares them) — added by hand here as a demonstrated
-- gap in the generator, not an arbitrary edit.
ALTER TABLE "services" ADD CONSTRAINT "services_duration_minutes_positive" CHECK ("services"."duration_minutes" > 0);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_price_minor_non_negative" CHECK ("services"."price_minor" >= 0);