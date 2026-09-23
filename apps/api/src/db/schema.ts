import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  time,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  AUDIT_ACTION_VALUES,
  BOOKING_STATUS_VALUES,
  DAY_OF_WEEK_VALUES,
  DEFAULT_CURRENCY,
  EXCEPTION_TYPE_VALUES,
  MEDICAL_RECORD_STATUS_VALUES,
  MEDICAL_RECORD_TYPE_VALUES,
  PAYMENT_STATUS_VALUES,
  PET_SEX_VALUES,
  PROVIDER_STATUS_VALUES,
  PROVIDER_TYPE_VALUES,
  ROLES,
} from "@pawlink/shared";

export const systemChecks = pgTable("system_checks", {
  id: serial("id").primaryKey(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roleEnum = pgEnum("role", ROLES);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  phone: varchar("phone", { length: 20 }).notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: roleEnum("role").notNull().default("PET_PARENT"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The session id stored here is a SHA-256 hash of the opaque token issued
// to the browser in the session cookie, so a database read alone can never
// yield a usable credential.
export const sessions = pgTable("sessions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const petSexEnum = pgEnum("pet_sex", PET_SEX_VALUES);

// A pet belongs to exactly one owner (notNull FK, no join table) and is
// removed if the owning account is removed (cascade), matching sessions.
export const pets = pgTable(
  "pets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    species: varchar("species", { length: 60 }).notNull(),
    breed: varchar("breed", { length: 120 }),
    sex: petSexEnum("sex").notNull().default("UNKNOWN"),
    dateOfBirth: date("date_of_birth"),
    weight: real("weight"),
    photoUrl: text("photo_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdIdx: index("pets_owner_id_idx").on(table.ownerId),
  }),
);

export const providerTypeEnum = pgEnum("provider_type", PROVIDER_TYPE_VALUES);
export const providerStatusEnum = pgEnum("provider_status", PROVIDER_STATUS_VALUES);

// A provider belongs to exactly one owning user (cascades if that account
// is deleted, same as pets). Providers themselves are expected to be
// referenced by future services/availability/bookings, so the provider
// row is never removed by the API — DELETE /api/providers/:id is
// implemented as a soft deactivation (status -> INACTIVE) precisely so
// those future FKs never end up pointing at a vanished provider. See
// routes/providers.ts.
export const providers = pgTable(
  "providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessName: varchar("business_name", { length: 200 }).notNull(),
    providerType: providerTypeEnum("provider_type").notNull(),
    description: text("description"),
    phone: varchar("phone", { length: 20 }),
    email: varchar("email", { length: 255 }),
    address: varchar("address", { length: 255 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 120 }),
    postalCode: varchar("postal_code", { length: 20 }),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    // A genuine IANA identifier (e.g. "Asia/Kolkata"), never a fixed
    // offset or abbreviation — see apps/api/src/lib/timezone.ts. Defaults
    // to "UTC" so every provider row always has an explicit, valid
    // timezone even if the owner hasn't set one yet.
    timezone: varchar("timezone", { length: 100 }).notNull().default("UTC"),
    status: providerStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerUserIdIdx: index("providers_owner_user_id_idx").on(table.ownerUserId),
    providerTypeIdx: index("providers_provider_type_idx").on(table.providerType),
    statusIdx: index("providers_status_idx").on(table.status),
    cityIdx: index("providers_city_idx").on(table.city),
  }),
);

// A service belongs to exactly one provider (notNull FK; cascades if the
// provider row is ever removed, matching the users->providers cascade —
// in practice providers are never hard-deleted through the API, only
// deactivated, so this is a safety net rather than a normal path).
//
// No unique constraint on (provider_id, name): a provider legitimately
// may want to reuse a name after deactivating an earlier variant (e.g.
// a seasonal "Full Grooming" offering), and deactivation is soft, so a
// hard uniqueness constraint would fight the deactivate-then-recreate
// workflow for no real benefit — duplicate-looking names within one
// provider's catalog aren't a data-integrity problem, just a display
// choice left to the provider.
//
// Money is never a float: price_minor is an integer count of the
// currency's smallest unit (e.g. ₹799.00 -> 79900 paise). See
// packages/shared/src/services.ts for the full rationale.
export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 150 }).notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull(),
    priceMinor: integer("price_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default(DEFAULT_CURRENCY),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerIdIdx: index("services_provider_id_idx").on(table.providerId),
    // Covers the exact predicate public discovery uses: WHERE provider_id
    // = ? AND active = true.
    providerActiveIdx: index("services_provider_active_idx").on(table.providerId, table.active),
    durationPositiveCheck: check("services_duration_minutes_positive", sql`${table.durationMinutes} > 0`),
    priceNonNegativeCheck: check("services_price_minor_non_negative", sql`${table.priceMinor} >= 0`),
  }),
);

export const dayOfWeekEnum = pgEnum("day_of_week", DAY_OF_WEEK_VALUES);

// Recurring weekly hours, stored as LOCAL wall-clock time-of-day (`time`,
// never a `timestamp`) — "9 AM to 5 PM on Mondays" means the same clock
// hours every week regardless of DST; see lib/timezone.ts. A provider may
// have several rows for the same day (a split schedule, e.g. 09:00-13:00
// and 14:00-18:00) — there is deliberately no unique constraint on
// (provider_id, day_of_week). Overlapping windows for the same
// provider+day ARE rejected, but at the application layer (see
// routes/availability.ts), not as a DB constraint — a true overlap
// exclusion constraint needs the btree_gist extension, and this table's
// write volume (an owner editing their own weekly hours) is low enough
// that the added extension dependency isn't justified for this milestone.
export const providerAvailability = pgTable(
  "provider_availability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    dayOfWeek: dayOfWeekEnum("day_of_week").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerDayIdx: index("provider_availability_provider_day_idx").on(table.providerId, table.dayOfWeek),
    endAfterStartCheck: check("provider_availability_end_after_start", sql`${table.endTime} > ${table.startTime}`),
  }),
);

export const exceptionTypeEnum = pgEnum("exception_type", EXCEPTION_TYPE_VALUES);

// A date-specific override of the weekly schedule (see
// lib/availability.ts's resolveWindowsForDate for the exact precedence
// rule: CLOSED -> no slots; CUSTOM_HOURS -> use these hours INSTEAD OF
// the weekly schedule, never combined with it). `date` is a calendar
// date (Postgres `date`, no time component) in the provider's own
// timezone — see lib/timezone.ts.
//
// UNIQUE(provider_id, date): a single calendar date can have at most one
// exception. There's no coherent meaning for two exception rows on the
// same date (closed AND custom hours simultaneously), so this is
// enforced as a hard database constraint rather than just an application
// check.
export const availabilityExceptions = pgTable(
  "availability_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    type: exceptionTypeEnum("type").notNull(),
    startTime: time("start_time"),
    endTime: time("end_time"),
    reason: varchar("reason", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The UNIQUE constraint below already creates a covering index on
    // (provider_id, date) — no separate index is needed.
    providerDateUnique: unique("availability_exceptions_provider_date_unique").on(table.providerId, table.date),
    shapeCheck: check(
      "availability_exceptions_shape",
      sql`(${table.type} = 'CLOSED' AND ${table.startTime} IS NULL AND ${table.endTime} IS NULL)
          OR (${table.type} = 'CUSTOM_HOURS' AND ${table.startTime} IS NOT NULL AND ${table.endTime} IS NOT NULL AND ${table.endTime} > ${table.startTime})`,
    ),
  }),
);

export const bookingStatusEnum = pgEnum("booking_status", BOOKING_STATUS_VALUES);

// Availability tells us what COULD be booked; this table is what actually
// IS booked — see docs/architecture.md for the full boundary.
//
// customer_user_id cascades on user deletion (consistent with every other
// user-owned row in this schema: pets, providers, sessions). provider_id,
// service_id, and pet_id are deliberately left at Postgres's default
// NO ACTION (never CASCADE) — a booking is a historical business record,
// and none of those three rows may ever be silently deleted out from
// under one. In practice providers/services are only ever soft-deactivated
// through the API, never hard-deleted, so this is a safety net; pets,
// however, ARE hard-deleted through the API (see routes/pets.ts) — that
// endpoint now catches the resulting FK violation and returns a clean 409
// instead of letting a raw database error leak through.
//
// price_minor/currency/service_name_snapshot/service_duration_minutes_snapshot
// are captured once, at booking creation time, from the service row as it
// existed then — never recalculated from the current services row. A
// provider changing a service's name, price, duration, or active status
// afterward must never alter what an existing booking represents.
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerUserId: uuid("customer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "restrict" }),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    status: bookingStatusEnum("status").notNull(),
    priceMinor: integer("price_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    serviceNameSnapshot: varchar("service_name_snapshot", { length: 150 }).notNull(),
    serviceDurationMinutesSnapshot: integer("service_duration_minutes_snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    customerUserIdIdx: index("bookings_customer_user_id_idx").on(table.customerUserId),
    providerIdIdx: index("bookings_provider_id_idx").on(table.providerId),
    providerStatusIdx: index("bookings_provider_status_idx").on(table.providerId, table.status),
    endAfterStartCheck: check("bookings_end_after_start", sql`${table.endAt} > ${table.startAt}`),
    priceNonNegativeCheck: check("bookings_price_minor_non_negative", sql`${table.priceMinor} >= 0`),
    // The actual double-booking prevention — a Postgres EXCLUDE constraint
    // over (provider_id, tstzrange(start_at, end_at)) for PENDING/
    // CONFIRMED/COMPLETED rows — cannot be expressed through drizzle-kit's
    // schema builder at all (no exclusion-constraint API, and this
    // drizzle-kit version doesn't even emit plain CHECK constraints — see
    // the services/availability migrations). It's added by hand to the
    // generated migration, together with `CREATE EXTENSION btree_gist`
    // which it requires. See drizzle/<migration>.sql and
    // docs/architecture.md for the full guarantee this provides.
  }),
);

// Backs the Idempotency-Key mechanism for POST /api/bookings. Keyed by
// (customer_user_id, key) — scoped per customer, not global, so one
// customer can never collide with or observe another's key. request_hash
// lets a replay of the *same* request return the original booking, while
// reusing the same key for a *materially different* request is rejected
// as a conflict rather than silently mutating the original booking's
// meaning. booking_id starts NULL and is filled in the same transaction
// that creates the booking — see routes/bookings.ts for why relying on
// this table's own unique index to serialize concurrent same-key
// requests (via ordinary Postgres row locking) is what makes "concurrent
// requests with the same key converge on one booking" correct without
// any additional application-level locking.
//
// No expiry/TTL: a key remains valid to safely retry indefinitely. A
// time-bounded expiry would need a cleanup job, which is out of scope for
// this milestone (see docs/architecture.md).
export const bookingIdempotencyKeys = pgTable(
  "booking_idempotency_keys",
  {
    customerUserId: uuid("customer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 255 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.customerUserId, table.key] }),
  }),
);

export const paymentStatusEnum = pgEnum("payment_status", PAYMENT_STATUS_VALUES);

// A booking has 1 --- 0..many payment ATTEMPTS (never overwritten — each
// row is a historical attempt, matching the same "never mutate history"
// principle as bookings.service_name_snapshot), but at most one may ever
// reach SUCCEEDED. That "at most one SUCCEEDED per booking" invariant is
// enforced by a hand-added PARTIAL UNIQUE INDEX (see the migration —
// drizzle-kit 0.24.2 has no schema-builder API for partial indexes, same
// documented gap as CHECK/EXCLUDE elsewhere in this file), not just
// application logic, so it holds even under a genuine race between two
// concurrent payment-creation requests.
//
// amount_minor/currency are captured once at payment-creation time from
// the booking's own (already-immutable) snapshot — never trusted from the
// client, never recalculated later. booking_id is RESTRICT (never
// CASCADE), matching provider_id/service_id/pet_id on bookings: a payment
// is a financial record and must never silently vanish because something
// else was deleted.
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    // Provider name, e.g. "mock" — the one concrete implementation today.
    // A real Stripe/Razorpay provider would be a different value here,
    // with no other schema change required (see lib/payment-provider.ts).
    provider: varchar("provider", { length: 50 }).notNull(),
    providerPaymentId: varchar("provider_payment_id", { length: 255 }),
    amountMinor: integer("amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    status: paymentStatusEnum("status").notNull().default("CREATED"),
    failureCode: varchar("failure_code", { length: 100 }),
    failureMessage: varchar("failure_message", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bookingIdIdx: index("payments_booking_id_idx").on(table.bookingId),
    statusIdx: index("payments_status_idx").on(table.status),
    // Uniqueness per (provider, provider_payment_id) — two payment rows,
    // even across different bookings, must never share the same
    // provider-side identifier. Postgres allows multiple NULLs through a
    // plain UNIQUE constraint, which is fine here since every payment
    // created through today's flow receives a providerPaymentId
    // synchronously from provider.createPayment().
    providerPaymentIdUnique: unique("payments_provider_provider_payment_id_unique").on(
      table.provider,
      table.providerPaymentId,
    ),
    amountNonNegativeCheck: check("payments_amount_minor_non_negative", sql`${table.amountMinor} >= 0`),
    // The "at most one SUCCEEDED payment per booking" partial unique
    // index is hand-added to the migration SQL — see the comment above
    // this table and docs/architecture.md, "Duplicate payment
    // protection."
  }),
);

// Mirrors booking_idempotency_keys exactly (same rationale: scoped per
// customer via a composite primary key so one customer can never collide
// with or observe another's key; request_hash lets a sequential replay of
// the SAME request return the original payment while reusing the key for
// a materially different request — here, a different bookingId, which is
// the only thing about a payment-creation request that can actually vary,
// since amount/currency are never client-supplied — is rejected as a
// conflict). No expiry, same reasoning as booking keys.
export const paymentIdempotencyKeys = pgTable(
  "payment_idempotency_keys",
  {
    customerUserId: uuid("customer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 255 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.customerUserId, table.key] }),
  }),
);

// Backs webhook idempotency: (provider, event_id) is UNIQUE, so
// processing the identical event twice is a plain INSERT ... ON CONFLICT
// DO NOTHING away from being a safe no-op the second time — the exact
// same technique booking_idempotency_keys already uses for concurrent
// same-key booking requests, applied here to concurrent/duplicate webhook
// deliveries instead. Persisted in Postgres (never an in-memory map), so
// it survives an API process restart, same as every other idempotency
// mechanism in this codebase.
export const paymentWebhookEvents = pgTable(
  "payment_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 50 }).notNull(),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerEventUnique: unique("payment_webhook_events_provider_event_id_unique").on(table.provider, table.eventId),
  }),
);

export const medicalRecordTypeEnum = pgEnum("medical_record_type", MEDICAL_RECORD_TYPE_VALUES);
export const medicalRecordStatusEnum = pgEnum("medical_record_status", MEDICAL_RECORD_STATUS_VALUES);

// The core sensitive-data table for this milestone. See
// docs/architecture.md, "Medical records," for the full authorization
// model; the short version enforced everywhere this table is touched
// (never at the client):
//
//   caller may read/write  <=>  caller owns the pet (read-only)
//                           OR  caller owns a provider with a legitimate
//                               (CONFIRMED/COMPLETED) booking against
//                               this exact pet
//
// pet_id/provider_id/booking_id/created_by_user_id are all RESTRICT (never
// CASCADE, never SET NULL) — a medical record is a historical business
// record and none of its identity fields may ever be silently orphaned or
// rewritten by something else being deleted. In practice this means a pet
// with medical history can no longer be hard-deleted through
// DELETE /api/pets/:id (routes/pets.ts already turns the resulting FK
// violation into a clean 409, the same way it already does for bookings).
//
// `details` is a small, per-record-type structured JSONB object — see
// packages/shared/src/medical-records.ts's detailsSchemaForType for the
// exact shape per record_type, validated on every write and never trusted
// as pre-validated on read.
//
// Records are never hard-deleted. The only lifecycle transition is
// ACTIVE -> ARCHIVED (see archive_shape check below); there is no
// un-archive and no DELETE endpoint at all.
export const medicalRecords = pgTable(
  "medical_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "restrict" }),
    recordType: medicalRecordTypeEnum("record_type").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    details: jsonb("details").notNull().default({}),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    status: medicalRecordStatusEnum("status").notNull().default("ACTIVE"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedReason: varchar("archived_reason", { length: 500 }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    petIdIdx: index("medical_records_pet_id_idx").on(table.petId),
    providerIdIdx: index("medical_records_provider_id_idx").on(table.providerId),
    // Covers the exact predicate the pet-scoped list endpoint uses: WHERE
    // pet_id = ? AND status = ? ORDER BY recorded_at DESC.
    petStatusIdx: index("medical_records_pet_status_idx").on(table.petId, table.status),
    createdAtIdx: index("medical_records_created_at_idx").on(table.createdAt),
    archiveShapeCheck: check(
      "medical_records_archive_shape",
      sql`(${table.status} = 'ACTIVE' AND ${table.archivedAt} IS NULL)
          OR (${table.status} = 'ARCHIVED' AND ${table.archivedAt} IS NOT NULL)`,
    ),
  }),
);

export const auditActionEnum = pgEnum("audit_action", AUDIT_ACTION_VALUES);

// Append-only. No route in this codebase ever UPDATEs or DELETEs a row in
// this table — see docs/architecture.md, "Audit logging." actor_user_id
// is RESTRICT (an account that has authored audit history can't be hard-
// deleted out from under it — moot today since there is no user-deletion
// endpoint at all). pet_id/provider_id are SET NULL on delete: unlike
// medical_records itself, the audit trail's job is to outlive the
// resources it describes, not to pin them in place — deleting a pet must
// never be blocked by its own audit history.
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: auditActionEnum("action").notNull(),
    resourceType: varchar("resource_type", { length: 50 }).notNull(),
    // Deliberately not a foreign key: resource_type varies (today always
    // "medical_record", but the enum already anticipates other resources)
    // and a denied/failed access may reference an id that was never valid
    // to begin with. Never used for cascade behavior.
    resourceId: uuid("resource_id"),
    petId: uuid("pet_id").references(() => pets.id, { onDelete: "set null" }),
    providerId: uuid("provider_id").references(() => providers.id, { onDelete: "set null" }),
    // Small operational context only (e.g. {"recordType":"VISIT"} or
    // {"changedFields":["title","recordedAt"]}) — never medical content.
    // See docs/architecture.md, "Sensitive data handling."
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actorUserIdIdx: index("audit_logs_actor_user_id_idx").on(table.actorUserId),
    petIdIdx: index("audit_logs_pet_id_idx").on(table.petId),
    providerIdIdx: index("audit_logs_provider_id_idx").on(table.providerId),
    resourceIdx: index("audit_logs_resource_idx").on(table.resourceType, table.resourceId),
    createdAtIdx: index("audit_logs_created_at_idx").on(table.createdAt),
  }),
);
