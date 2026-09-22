CREATE TABLE IF NOT EXISTS "system_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
