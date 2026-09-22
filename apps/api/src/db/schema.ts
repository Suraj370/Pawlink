import { date, doublePrecision, index, pgEnum, pgTable, real, serial, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { PET_SEX_VALUES, PROVIDER_STATUS_VALUES, PROVIDER_TYPE_VALUES, ROLES } from "@pawlink/shared";

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
