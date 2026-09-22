DO $$ BEGIN
 CREATE TYPE "public"."day_of_week" AS ENUM('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."exception_type" AS ENUM('CLOSED', 'CUSTOM_HOURS');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "availability_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"date" date NOT NULL,
	"type" "exception_type" NOT NULL,
	"start_time" time,
	"end_time" time,
	"reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_exceptions_provider_date_unique" UNIQUE("provider_id","date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"day_of_week" "day_of_week" NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "timezone" varchar(100) DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_availability" ADD CONSTRAINT "provider_availability_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_availability_provider_day_idx" ON "provider_availability" USING btree ("provider_id","day_of_week");--> statement-breakpoint
-- drizzle-kit 0.24.2 does not emit CHECK constraints from pg-core's
-- check() builder (same gap documented for the services migration) —
-- added by hand, not an arbitrary edit.
ALTER TABLE "provider_availability" ADD CONSTRAINT "provider_availability_end_after_start" CHECK ("provider_availability"."end_time" > "provider_availability"."start_time");--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_shape" CHECK (
  ("availability_exceptions"."type" = 'CLOSED' AND "availability_exceptions"."start_time" IS NULL AND "availability_exceptions"."end_time" IS NULL)
  OR ("availability_exceptions"."type" = 'CUSTOM_HOURS' AND "availability_exceptions"."start_time" IS NOT NULL AND "availability_exceptions"."end_time" IS NOT NULL AND "availability_exceptions"."end_time" > "availability_exceptions"."start_time")
);