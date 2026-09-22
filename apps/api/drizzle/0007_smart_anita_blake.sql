DO $$ BEGIN
 CREATE TYPE "public"."payment_status" AS ENUM('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_idempotency_keys" (
	"customer_user_id" uuid NOT NULL,
	"key" varchar(255) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_idempotency_keys_customer_user_id_key_pk" PRIMARY KEY("customer_user_id","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"payment_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_webhook_events_provider_event_id_unique" UNIQUE("provider","event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_payment_id" varchar(255),
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "payment_status" DEFAULT 'CREATED' NOT NULL,
	"failure_code" varchar(100),
	"failure_message" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_provider_payment_id_unique" UNIQUE("provider","provider_payment_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_idempotency_keys" ADD CONSTRAINT "payment_idempotency_keys_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_idempotency_keys" ADD CONSTRAINT "payment_idempotency_keys_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_booking_id_idx" ON "payments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
-- drizzle-kit 0.24.2 does not emit CHECK constraints from pg-core's
-- check() builder (same documented gap as every other migration in this
-- repository) — added by hand, not an arbitrary edit.
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_minor_non_negative" CHECK ("payments"."amount_minor" >= 0);--> statement-breakpoint

-- "At most one SUCCEEDED payment per booking" — the duplicate-payment
-- protection invariant (see docs/architecture.md, "Duplicate payment
-- protection"). drizzle-kit's schema builder has no API for PARTIAL
-- indexes at all (same category of gap as the booking engine's EXCLUDE
-- constraint), so this is necessarily hand-written. A plain UNIQUE
-- constraint on booking_id would be wrong here — it would also block a
-- second FAILED/CANCELLED attempt from ever being recorded, which is a
-- legitimate historical row (booking 1 --- many payment ATTEMPTS, see
-- schema.ts). The partial predicate (status = 'SUCCEEDED') is what makes
-- only the one invariant that actually matters — "never two successful
-- payments for the same booking" — a hard database guarantee, atomic
-- under concurrency, rather than a check-then-insert race in application
-- code.
CREATE UNIQUE INDEX IF NOT EXISTS "payments_one_succeeded_per_booking"
  ON "payments" ("booking_id")
  WHERE ("status" = 'SUCCEEDED');