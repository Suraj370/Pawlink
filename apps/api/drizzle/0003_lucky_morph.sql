DO $$ BEGIN
 CREATE TYPE "public"."provider_status" AS ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."provider_type" AS ENUM('VET', 'GROOMER', 'BOARDING_PROVIDER', 'PET_SHOP');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"business_name" varchar(200) NOT NULL,
	"provider_type" "provider_type" NOT NULL,
	"description" text,
	"phone" varchar(20),
	"email" varchar(255),
	"address" varchar(255),
	"city" varchar(120),
	"state" varchar(120),
	"postal_code" varchar(20),
	"latitude" double precision,
	"longitude" double precision,
	"status" "provider_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "providers" ADD CONSTRAINT "providers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "providers_owner_user_id_idx" ON "providers" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "providers_provider_type_idx" ON "providers" USING btree ("provider_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "providers_status_idx" ON "providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "providers_city_idx" ON "providers" USING btree ("city");