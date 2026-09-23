import { Hono, type Context } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  archiveMedicalRecordSchema,
  createMedicalRecordSchema,
  detailsSchemaForType,
  medicalRecordListQuerySchema,
  updateMedicalRecordSchema,
} from "@pawlink/shared";
import type { AppEnv } from "../types.js";
import type { DbClient } from "../db/client.js";
import { medicalRecords, pets, providers } from "../db/schema.js";
import {
  findAuthorizedProviderIds,
  loadLegitimateBooking,
  MedicalRecordBookingError,
  toPublicMedicalRecord,
} from "../lib/medical-record.js";
import { recordAuditEvent } from "../lib/audit.js";
import { createRequireAuth } from "../middleware/auth.js";

const uuidSchema = z.string().uuid();
const RESOURCE_TYPE = "medical_record";

// Same information-hiding convention used throughout this codebase
// (pets.ts, services.ts, bookings.ts): an id that's syntactically valid
// but doesn't resolve to something the caller may see/act on returns 404,
// identically to a truly nonexistent id — this is what keeps a pet id or
// a medical record id from being an authorization credential in itself
// (see the milestone's central rule: "a pet ID is not an authorization
// credential").
const PET_NOT_FOUND = { error: "Pet not found" } as const;
const MEDICAL_RECORD_NOT_FOUND = { error: "Medical record not found" } as const;

type PetRow = typeof pets.$inferSelect;
type UserCtx = { id: string; role: string };

// The one authorization primitive every route below is built from. Never
// trusts anything from the request except the pet id already resolved
// from a trusted row read — the provider relationship is always
// recomputed from the database, never accepted from the client. See
// lib/medical-record.ts.
async function resolvePetAccess(db: DbClient, user: UserCtx, pet: PetRow) {
  const isOwner = pet.ownerId === user.id;
  const authorizedProviderIds = await findAuthorizedProviderIds(db, { userId: user.id, petId: pet.id });
  return { isOwner, authorizedProviderIds, canRead: isOwner || authorizedProviderIds.length > 0 };
}

async function providerNameMap(db: DbClient, providerIds: string[]): Promise<Map<string, string>> {
  if (providerIds.length === 0) return new Map();
  const rows = await db
    .select({ id: providers.id, businessName: providers.businessName })
    .from(providers)
    .where(inArray(providers.id, [...new Set(providerIds)]));
  return new Map(rows.map((r) => [r.id, r.businessName]));
}

// -----------------------------------------------------------------------
// Pet-scoped routes: GET/POST /api/pets/:petId/medical-records
// -----------------------------------------------------------------------
export function createPetMedicalRecordRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);
  app.use("*", requireAuth);

  async function loadPet(c: Context<AppEnv>) {
    const idResult = uuidSchema.safeParse(c.req.param("petId"));
    if (!idResult.success) return { error: c.json({ error: "Invalid pet id" }, 400) } as const;
    const pet = await db.query.pets.findFirst({ where: eq(pets.id, idResult.data) });
    if (!pet) return { error: c.json(PET_NOT_FOUND, 404) } as const;
    return { pet } as const;
  }

  // GET / — the pet's own owner sees every record (subject to
  // ?includeArchived); a provider with a current legitimate relationship
  // to this pet sees the SAME full history, including records authored by
  // other providers who have also legitimately treated this pet
  // (continuity of care) — never just their own-authored subset. Anyone
  // else gets 404, identical to a nonexistent pet id.
  app.get("/", async (c) => {
    const loaded = await loadPet(c);
    if ("error" in loaded) return loaded.error;
    const { pet } = loaded;

    const parsedQuery = medicalRecordListQuerySchema.safeParse({
      recordType: c.req.query("recordType") || undefined,
      includeArchived: c.req.query("includeArchived") ?? undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: "Invalid query", fields: parsedQuery.error.flatten().fieldErrors }, 400);
    }

    const user = c.get("user");
    const access = await resolvePetAccess(db, user, pet);
    if (!access.canRead) {
      return c.json(PET_NOT_FOUND, 404);
    }

    const conditions = [eq(medicalRecords.petId, pet.id)];
    if (!parsedQuery.data.includeArchived) conditions.push(eq(medicalRecords.status, "ACTIVE"));
    if (parsedQuery.data.recordType) conditions.push(eq(medicalRecords.recordType, parsedQuery.data.recordType));

    const rows = await db.query.medicalRecords.findMany({
      where: and(...conditions),
      orderBy: desc(medicalRecords.recordedAt),
    });
    const names = await providerNameMap(db, rows.map((r) => r.providerId));

    // A bulk read of a pet's medical history is exactly the kind of
    // sensitive access the audit trail exists to capture — recorded once
    // per list request (not once per row, which would just be noise) with
    // only a count in metadata, never any record's actual content.
    await recordAuditEvent(db, {
      actorUserId: user.id,
      action: "MEDICAL_RECORD_VIEWED",
      resourceType: RESOURCE_TYPE,
      petId: pet.id,
      metadata: { view: "list", count: rows.length },
    });

    return c.json({ medicalRecords: rows.map((r) => toPublicMedicalRecord(r, names.get(r.providerId) ?? "")) }, 200);
  });

  // POST / — provider-only. The authorized provider is derived from the
  // session + this pet's real booking history (findAuthorizedProviderIds),
  // never accepted as-is from the client. A client-supplied providerId is
  // only ever checked for membership in that derived set (a
  // disambiguator, not a credential) — see lib/medical-record.ts and
  // docs/architecture.md.
  app.post("/", async (c) => {
    const loaded = await loadPet(c);
    if ("error" in loaded) return loaded.error;
    const { pet } = loaded;

    const user = c.get("user");
    const access = await resolvePetAccess(db, user, pet);

    if (access.authorizedProviderIds.length === 0) {
      if (access.isOwner) {
        // The caller already knows this pet exists (they own it) — no
        // enumeration risk in telling them plainly why the write is
        // rejected.
        await recordAuditEvent(db, {
          actorUserId: user.id,
          action: "AUTHORIZATION_DENIED",
          resourceType: RESOURCE_TYPE,
          petId: pet.id,
          metadata: { reason: "pet_owner_not_provider" },
        });
        return c.json({ error: "Only a provider with a confirmed booking for this pet may add a medical record" }, 403);
      }
      await recordAuditEvent(db, {
        actorUserId: user.id,
        action: "AUTHORIZATION_DENIED",
        resourceType: RESOURCE_TYPE,
        petId: pet.id,
        metadata: { reason: "no_relationship" },
      });
      return c.json(PET_NOT_FOUND, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = createMedicalRecordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }
    const input = parsed.data;

    let providerId: string;
    if (input.providerId) {
      if (!access.authorizedProviderIds.includes(input.providerId)) {
        return c.json({ error: "providerId is not authorized for this pet" }, 403);
      }
      providerId = input.providerId;
    } else if (access.authorizedProviderIds.length === 1) {
      providerId = access.authorizedProviderIds[0];
    } else {
      return c.json({ error: "You own multiple providers eligible for this pet; specify providerId" }, 400);
    }

    if (input.bookingId) {
      try {
        await loadLegitimateBooking(db, { bookingId: input.bookingId, petId: pet.id, providerId });
      } catch (err) {
        if (err instanceof MedicalRecordBookingError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    }

    // details was already structurally validated against the correct
    // shape for recordType by createMedicalRecordSchema's superRefine —
    // re-parsing here just gets a cleanly-typed, key-stripped value to
    // persist, not a second independent check.
    const details = detailsSchemaForType(input.recordType).parse(input.details ?? {});

    const [inserted] = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(medicalRecords)
        .values({
          petId: pet.id,
          providerId,
          bookingId: input.bookingId ?? null,
          recordType: input.recordType,
          title: input.title,
          description: input.description ?? null,
          details,
          recordedAt: new Date(input.recordedAt),
          createdByUserId: user.id,
        })
        .returning();

      await recordAuditEvent(tx, {
        actorUserId: user.id,
        action: "MEDICAL_RECORD_CREATED",
        resourceType: RESOURCE_TYPE,
        resourceId: row.id,
        petId: pet.id,
        providerId,
        metadata: { recordType: input.recordType },
      });

      return [row];
    });

    const names = await providerNameMap(db, [providerId]);
    return c.json({ medicalRecord: toPublicMedicalRecord(inserted, names.get(providerId) ?? "") }, 201);
  });

  return app;
}

// -----------------------------------------------------------------------
// Record-scoped routes: GET/PATCH /api/medical-records/:id,
// POST /api/medical-records/:id/archive
// -----------------------------------------------------------------------
export function createMedicalRecordRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);
  app.use("*", requireAuth);

  async function loadRecord(recordId: string) {
    const record = await db.query.medicalRecords.findFirst({ where: eq(medicalRecords.id, recordId) });
    if (!record) return null;
    const pet = await db.query.pets.findFirst({ where: eq(pets.id, record.petId) });
    // pet_id is a RESTRICT foreign key — a record can never outlive its
    // pet — so a missing pet row here would indicate corrupted state, not
    // a legitimate runtime case. Treated the same as "not found" rather
    // than throwing, since there's nothing a caller can do about it.
    if (!pet) return null;
    return { record, pet };
  }

  // Only the record's authoring provider (the user who owns the provider
  // business that created it) or an admin may write to it — see the
  // milestone brief, section 9 ("Pet owners should NOT be able to
  // silently alter provider-authored medical records") and section 8
  // ("Provider may NOT... update records they are [not] authorized to
  // update," i.e. records authored by a DIFFERENT provider, even one who
  // also treats this same pet).
  function isAuthoringProvider(record: { providerId: string }, providerRow: { id: string; ownerUserId: string } | undefined, user: UserCtx) {
    return !!providerRow && providerRow.id === record.providerId && providerRow.ownerUserId === user.id;
  }

  app.get("/:id", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid medical record id" }, 400);

    const loaded = await loadRecord(idResult.data);
    if (!loaded) return c.json(MEDICAL_RECORD_NOT_FOUND, 404);
    const { record, pet } = loaded;

    const user = c.get("user");
    const access = await resolvePetAccess(db, user, pet);
    if (!access.canRead) {
      await recordAuditEvent(db, {
        actorUserId: user.id,
        action: "AUTHORIZATION_DENIED",
        resourceType: RESOURCE_TYPE,
        resourceId: record.id,
        petId: pet.id,
        providerId: record.providerId,
        metadata: { reason: "no_relationship" },
      });
      return c.json(MEDICAL_RECORD_NOT_FOUND, 404);
    }

    await recordAuditEvent(db, {
      actorUserId: user.id,
      action: "MEDICAL_RECORD_VIEWED",
      resourceType: RESOURCE_TYPE,
      resourceId: record.id,
      petId: pet.id,
      providerId: record.providerId,
    });

    const names = await providerNameMap(db, [record.providerId]);
    return c.json({ medicalRecord: toPublicMedicalRecord(record, names.get(record.providerId) ?? "") }, 200);
  });

  app.patch("/:id", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid medical record id" }, 400);

    const loaded = await loadRecord(idResult.data);
    if (!loaded) return c.json(MEDICAL_RECORD_NOT_FOUND, 404);
    const { record, pet } = loaded;

    const user = c.get("user");
    const access = await resolvePetAccess(db, user, pet);
    if (!access.canRead) {
      await recordAuditEvent(db, {
        actorUserId: user.id,
        action: "AUTHORIZATION_DENIED",
        resourceType: RESOURCE_TYPE,
        resourceId: record.id,
        petId: pet.id,
        providerId: record.providerId,
        metadata: { reason: "no_relationship", attempted: "update" },
      });
      return c.json(MEDICAL_RECORD_NOT_FOUND, 404);
    }

    const providerRow = await db.query.providers.findFirst({ where: eq(providers.id, record.providerId) });
    if (!isAuthoringProvider(record, providerRow, user)) {
      // The caller can already see this record (access.canRead is true),
      // so a 403 here reveals nothing they don't already know.
      await recordAuditEvent(db, {
        actorUserId: user.id,
        action: "AUTHORIZATION_DENIED",
        resourceType: RESOURCE_TYPE,
        resourceId: record.id,
        petId: pet.id,
        providerId: record.providerId,
        metadata: { reason: "not_authoring_provider", attempted: "update" },
      });
      return c.json({ error: "Only the authoring provider may update this record" }, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = updateMedicalRecordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }
    if (Object.keys(parsed.data).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const updateValues: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.title !== undefined) updateValues.title = parsed.data.title;
    if (parsed.data.description !== undefined) updateValues.description = parsed.data.description;
    if (parsed.data.recordedAt !== undefined) updateValues.recordedAt = new Date(parsed.data.recordedAt);
    if (parsed.data.details !== undefined) {
      // updateMedicalRecordSchema deliberately leaves `details` as
      // z.unknown() (its shape depends on the record's own recordType,
      // which isn't known until here) — so, unlike creation, this is the
      // FIRST and only shape check `details` gets on an update. safeParse,
      // not parse: a shape mismatch must fall through to the same 400
      // every other validation failure gets, never an uncaught throw into
      // app.onError's generic 500.
      const detailsResult = detailsSchemaForType(record.recordType).safeParse(parsed.data.details);
      if (!detailsResult.success) {
        return c.json({ error: "Invalid input", fields: detailsResult.error.flatten().fieldErrors }, 400);
      }
      updateValues.details = detailsResult.data;
    }
    const changedFields = Object.keys(updateValues).filter((k) => k !== "updatedAt");

    const [updated] = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(medicalRecords)
        .set(updateValues)
        .where(eq(medicalRecords.id, record.id))
        .returning();

      await recordAuditEvent(tx, {
        actorUserId: user.id,
        action: "MEDICAL_RECORD_UPDATED",
        resourceType: RESOURCE_TYPE,
        resourceId: record.id,
        petId: pet.id,
        providerId: record.providerId,
        metadata: { changedFields },
      });

      return [row];
    });

    const names = await providerNameMap(db, [record.providerId]);
    return c.json({ medicalRecord: toPublicMedicalRecord(updated, names.get(record.providerId) ?? "") }, 200);
  });

  // POST /:id/archive — soft lifecycle transition only. There is no
  // un-archive and no hard-delete endpoint anywhere in this router (see
  // docs/architecture.md, "Medical record lifecycle").
  app.post("/:id/archive", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid medical record id" }, 400);

    const loaded = await loadRecord(idResult.data);
    if (!loaded) return c.json(MEDICAL_RECORD_NOT_FOUND, 404);
    const { record, pet } = loaded;

    const user = c.get("user");
    const access = await resolvePetAccess(db, user, pet);
    if (!access.canRead) {
      await recordAuditEvent(db, {
        actorUserId: user.id,
        action: "AUTHORIZATION_DENIED",
        resourceType: RESOURCE_TYPE,
        resourceId: record.id,
        petId: pet.id,
        providerId: record.providerId,
        metadata: { reason: "no_relationship", attempted: "archive" },
      });
      return c.json(MEDICAL_RECORD_NOT_FOUND, 404);
    }

    const providerRow = await db.query.providers.findFirst({ where: eq(providers.id, record.providerId) });
    if (!isAuthoringProvider(record, providerRow, user)) {
      await recordAuditEvent(db, {
        actorUserId: user.id,
        action: "AUTHORIZATION_DENIED",
        resourceType: RESOURCE_TYPE,
        resourceId: record.id,
        petId: pet.id,
        providerId: record.providerId,
        metadata: { reason: "not_authoring_provider", attempted: "archive" },
      });
      return c.json({ error: "Only the authoring provider may archive this record" }, 403);
    }

    if (record.status === "ARCHIVED") {
      return c.json({ error: "This record is already archived" }, 409);
    }

    let body: unknown = {};
    const rawBody = await c.req.text();
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
    }
    const parsed = archiveMedicalRecordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    const [updated] = await db.transaction(async (tx) => {
      const now = new Date();
      const [row] = await tx
        .update(medicalRecords)
        .set({ status: "ARCHIVED", archivedAt: now, archivedReason: parsed.data.reason ?? null, updatedAt: now })
        .where(eq(medicalRecords.id, record.id))
        .returning();

      await recordAuditEvent(tx, {
        actorUserId: user.id,
        action: "MEDICAL_RECORD_ARCHIVED",
        resourceType: RESOURCE_TYPE,
        resourceId: record.id,
        petId: pet.id,
        providerId: record.providerId,
      });

      return [row];
    });

    const names = await providerNameMap(db, [record.providerId]);
    return c.json({ medicalRecord: toPublicMedicalRecord(updated, names.get(record.providerId) ?? "") }, 200);
  });

  return app;
}
