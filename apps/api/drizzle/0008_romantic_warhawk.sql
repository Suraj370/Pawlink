DO $$ BEGIN
 CREATE TYPE "public"."audit_action" AS ENUM('MEDICAL_RECORD_CREATED', 'MEDICAL_RECORD_VIEWED', 'MEDICAL_RECORD_UPDATED', 'MEDICAL_RECORD_ARCHIVED', 'AUTHORIZATION_DENIED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."medical_record_status" AS ENUM('ACTIVE', 'ARCHIVED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."medical_record_type" AS ENUM('VISIT', 'DIAGNOSIS', 'VACCINATION', 'MEDICATION', 'ALLERGY', 'LAB_RESULT', 'SURGERY', 'OTHER');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" "audit_action" NOT NULL,
	"resource_type" varchar(50) NOT NULL,
	"resource_id" uuid,
	"pet_id" uuid,
	"provider_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "medical_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pet_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"booking_id" uuid,
	"record_type" "medical_record_type" NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"status" "medical_record_status" DEFAULT 'ACTIVE' NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_reason" varchar(500),
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_actor_user_id_idx" ON "audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_pet_id_idx" ON "audit_logs" USING btree ("pet_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_provider_id_idx" ON "audit_logs" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medical_records_pet_id_idx" ON "medical_records" USING btree ("pet_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medical_records_provider_id_idx" ON "medical_records" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medical_records_pet_status_idx" ON "medical_records" USING btree ("pet_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medical_records_created_at_idx" ON "medical_records" USING btree ("created_at");--> statement-breakpoint

-- drizzle-kit 0.24.2 does not emit CHECK constraints from pg-core's
-- check() builder (same documented gap as the services/bookings/
-- availability_exceptions migrations) — added by hand, not an arbitrary
-- edit.
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_archive_shape" CHECK (
  ("medical_records"."status" = 'ACTIVE' AND "medical_records"."archived_at" IS NULL)
  OR ("medical_records"."status" = 'ARCHIVED' AND "medical_records"."archived_at" IS NOT NULL)
);