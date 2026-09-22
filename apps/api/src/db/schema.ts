import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
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
  BOOKING_STATUS_VALUES,
  DAY_OF_WEEK_VALUES,
  DEFAULT_CURRENCY,
  EXCEPTION_TYPE_VALUES,
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
