DO $$ BEGIN
 CREATE TYPE "public"."booking_status" AS ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "booking_idempotency_keys" (
	"customer_user_id" uuid NOT NULL,
	"key" varchar(255) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"booking_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_idempotency_keys_customer_user_id_key_pk" PRIMARY KEY("customer_user_id","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"pet_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" "booking_status" NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"service_name_snapshot" varchar(150) NOT NULL,
	"service_duration_minutes_snapshot" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_idempotency_keys" ADD CONSTRAINT "booking_idempotency_keys_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_idempotency_keys" ADD CONSTRAINT "booking_idempotency_keys_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookings" ADD CONSTRAINT "bookings_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookings" ADD CONSTRAINT "bookings_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_customer_user_id_idx" ON "bookings" USING btree ("customer_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_provider_id_idx" ON "bookings" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_provider_status_idx" ON "bookings" USING btree ("provider_id","status");--> statement-breakpoint
-- drizzle-kit 0.24.2 does not emit CHECK constraints from pg-core's
-- check() builder (same documented gap as the services/provider_availability
-- migrations) — added by hand, not an arbitrary edit.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_end_after_start" CHECK ("bookings"."end_at" > "bookings"."start_at");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_price_minor_non_negative" CHECK ("bookings"."price_minor" >= 0);--> statement-breakpoint

-- THE double-booking guarantee. drizzle-kit's schema builder has no API
-- for exclusion constraints at all, so this is necessarily hand-written
-- (documented, not an arbitrary edit — see apps/api/src/db/schema.ts's
-- comment on the bookings table).
--
-- btree_gist is required because provider_id (a uuid, normally compared
-- with plain btree equality) needs a GiST-compatible equality operator
-- class to be combined with the tstzrange overlap operator (&&) in a
-- single GiST exclusion constraint; btree_gist supplies exactly that.
-- This is a deliberate, minimal extension — evaluated and introduced
-- specifically because Postgres has no other mechanism that enforces
-- "no two active bookings for the same provider may have overlapping
-- time ranges" as an atomic, race-proof, server-side invariant. An
-- application-level SELECT-then-INSERT (or even a SELECT ... FOR UPDATE
-- lock) cannot provide the same guarantee under true concurrency the way
-- a single atomic constraint check inside one INSERT's transaction does.
--
-- WHERE clause: only PENDING/CONFIRMED/COMPLETED bookings occupy a
-- provider's time — a CANCELLED booking never blocks a new one from
-- being created over the same range (see BLOCKING_BOOKING_STATUSES,
-- packages/shared/src/bookings.ts, for the single source of truth this
-- WHERE clause must stay in sync with).
--
-- tstzrange(start_at, end_at) defaults to the half-open interval
-- [start_at, end_at) — a booking ending at 10:00 does not conflict with
-- one starting at 10:00, consistent with every other overlap check in
-- this codebase (weekly-window overlap, excludeBookedSlots()).
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlapping_active"
  EXCLUDE USING gist (
    provider_id WITH =,
    tstzrange(start_at, end_at) WITH &&
  )
  WHERE (status IN ('PENDING', 'CONFIRMED', 'COMPLETED'));