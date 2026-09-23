import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, promoteToAdmin, registerAndLogin } from "./test-helpers.js";
import { auditLogs, bookings, medicalRecords, payments, providers, users } from "./db/schema.js";

const { app, db } = createTestApp();

const createdEmails: string[] = [];

afterAll(async () => {
  if (createdEmails.length === 0) return;

  const testUsers = await db.query.users.findMany({ where: inArray(users.email, createdEmails) });
  const userIds = testUsers.map((u) => u.id);
  if (userIds.length > 0) {
    const ownedProviders = await db.query.providers.findMany({ where: inArray(providers.ownerUserId, userIds) });
    const providerIds = ownedProviders.map((p) => p.id);
    const ownedBookings = providerIds.length > 0 ? await db.query.bookings.findMany({ where: inArray(bookings.providerId, providerIds) }) : [];
    const customerBookings = await db.query.bookings.findMany({ where: inArray(bookings.customerUserId, userIds) });
    const bookingIds = [...new Set([...ownedBookings.map((b) => b.id), ...customerBookings.map((b) => b.id)])];

    await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, userIds));
    if (bookingIds.length > 0) {
      await db.delete(medicalRecords).where(inArray(medicalRecords.bookingId, bookingIds));
    }
    if (providerIds.length > 0) {
      await db.delete(medicalRecords).where(inArray(medicalRecords.providerId, providerIds));
    }
    if (bookingIds.length > 0) {
      await db.delete(payments).where(inArray(payments.bookingId, bookingIds));
    }
    if (providerIds.length > 0) {
      await db.delete(bookings).where(inArray(bookings.providerId, providerIds));
    }
    await db.delete(bookings).where(inArray(bookings.customerUserId, userIds));
  }

  for (const email of createdEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
});

async function asUser() {
  const session = await registerAndLogin(app);
  createdEmails.push(session.email);
  return session;
}

async function asAdmin() {
  const session = await asUser();
  await promoteToAdmin(db, session.userId);
  return session;
}

function futureMonday(offsetWeeks = 0): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 2);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + offsetWeeks * 7);
  return d.toISOString().slice(0, 10);
}

async function createProvider(cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await app.request("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ businessName: "Med Records Test Vet", providerType: "VET", timezone: "UTC", ...overrides }),
  });
  const { provider } = (await res.json()) as { provider: { id: string; ownerUserId?: string } };
  return provider;
}

async function createService(cookie: string, providerId: string, overrides: Record<string, unknown> = {}) {
  const res = await app.request(`/api/providers/${providerId}/services`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name: "Checkup", durationMinutes: 60, priceMinor: 5000, currency: "INR", ...overrides }),
  });
  const { service } = (await res.json()) as { service: { id: string } };
  return service;
}

async function createRule(cookie: string, providerId: string, overrides: Record<string, unknown> = {}) {
  await app.request(`/api/providers/${providerId}/availability/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00", ...overrides }),
  });
}

async function createPet(cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await app.request("/api/pets", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name: "Rex", species: "Dog", ...overrides }),
  });
  const { pet } = (await res.json()) as { pet: { id: string } };
  return pet;
}

async function createBooking(cookie: string, providerId: string, serviceId: string, petId: string, startAt: string) {
  const res = await app.request("/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ providerId, serviceId, petId, startAt }),
  });
  const { booking } = (await res.json()) as { booking: { id: string; status: string } };
  return booking;
}

async function payBooking(cookie: string, bookingId: string) {
  await app.request(`/api/bookings/${bookingId}/payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({}),
  });
}

// Full setup: a provider owner, a customer who owns a pet, and a
// CONFIRMED booking between them — the "legitimate relationship" the
// entire authorization model is built on.
async function setupTreatedPet(monday = futureMonday()) {
  const owner = await asUser();
  const provider = await createProvider(owner.cookie);
  const service = await createService(owner.cookie, provider.id);
  await createRule(owner.cookie, provider.id);
  const customer = await asUser();
  const pet = await createPet(customer.cookie);

  const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${monday}T09:00:00+00:00`);
  await payBooking(customer.cookie, booking.id);

  return { owner, provider, service, customer, pet, booking, monday };
}

async function createRecord(
  cookie: string,
  petId: string,
  body: Record<string, unknown>,
) {
  return app.request(`/api/pets/${petId}/medical-records`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

function visitBody(overrides: Record<string, unknown> = {}) {
  return {
    recordType: "VISIT",
    title: "Annual checkup",
    description: "Routine wellness exam",
    recordedAt: "2026-01-15T09:30:00+00:00",
    details: { chiefComplaint: "None", observations: "Healthy", diagnosis: "N/A", treatment: "None", followUpNotes: "1 year" },
    ...overrides,
  };
}

describe("POST /api/pets/:petId/medical-records — creation", () => {
  it("lets the treating provider create a VISIT record", async () => {
    const { owner, provider, pet, booking } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id, bookingId: booking.id }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { medicalRecord: Record<string, unknown> };
    expect(json.medicalRecord.petId).toBe(pet.id);
    expect(json.medicalRecord.providerId).toBe(provider.id);
    expect(json.medicalRecord.bookingId).toBe(booking.id);
    expect(json.medicalRecord.status).toBe("ACTIVE");
    expect(json.medicalRecord.createdByUserId).toBe(owner.userId);
  });

  it("derives the provider automatically when the caller owns exactly one eligible provider", async () => {
    const { owner, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, visitBody());
    expect(res.status).toBe(201);
  });

  it("rejects an unknown recordType", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id, recordType: "NOT_A_TYPE" }));
    expect(res.status).toBe(400);
  });

  it("rejects details that don't match the record type's shape", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, {
      recordType: "VACCINATION",
      providerId: provider.id,
      title: "Rabies",
      recordedAt: "2026-01-15T09:30:00+00:00",
      details: { notAVaccineField: true },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { fields?: Record<string, unknown> };
    expect(json.fields).toBeTruthy();
  });

  it("rejects an empty title", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id, title: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects an oversized title", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id, title: "x".repeat(500) }));
    expect(res.status).toBe(400);
  });

  it("rejects an oversized details field instead of storing it", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(
      owner.cookie,
      pet.id,
      visitBody({ providerId: provider.id, details: { observations: "x".repeat(50_000) } }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown fields inside details (no arbitrary data dumping ground)", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(
      owner.cookie,
      pet.id,
      visitBody({ providerId: provider.id, details: { chiefComplaint: "ok", extraHackerField: "x" } }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a nonexistent pet id", async () => {
    const { owner } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, "00000000-0000-0000-0000-000000000000", visitBody());
    expect(res.status).toBe(404);
  });

  it("rejects an invalid (non-UUID) pet id", async () => {
    const { owner } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, "not-a-uuid", visitBody());
    expect(res.status).toBe(400);
  });

  it("rejects an invalid provider disambiguator not owned by the caller", async () => {
    const { owner, pet } = await setupTreatedPet();
    const otherProvider = await createProvider((await asUser()).cookie);
    const res = await createRecord(owner.cookie, pet.id, visitBody({ providerId: otherProvider.id }));
    expect(res.status).toBe(403);
  });

  it("rejects a bookingId that belongs to a different pet", async () => {
    const first = await setupTreatedPet();
    const second = await setupTreatedPet();
    const res = await createRecord(
      first.owner.cookie,
      first.pet.id,
      visitBody({ providerId: first.provider.id, bookingId: second.booking.id }),
    );
    expect(res.status).toBe(400);
  });

  it("mass assignment: ignores a client-supplied createdByUserId/status/archivedAt", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(
      owner.cookie,
      pet.id,
      visitBody({ providerId: provider.id, createdByUserId: "11111111-1111-1111-1111-111111111111", status: "ARCHIVED", archivedAt: "2020-01-01T00:00:00Z" }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { medicalRecord: Record<string, unknown> };
    expect(json.medicalRecord.createdByUserId).toBe(owner.userId);
    expect(json.medicalRecord.status).toBe("ACTIVE");
    expect(json.medicalRecord.archivedAt).toBeNull();
  });
});

describe("record types — structured details", () => {
  it("creates a VACCINATION record with vaccine-specific fields", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, {
      recordType: "VACCINATION",
      providerId: provider.id,
      title: "Rabies vaccine",
      recordedAt: "2026-01-15T09:30:00+00:00",
      details: { vaccineName: "Rabies", administeredAt: "2026-01-15", nextDueAt: "2027-01-15" },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { medicalRecord: { details: Record<string, unknown> } };
    expect(json.medicalRecord.details.vaccineName).toBe("Rabies");
  });

  it("creates a MEDICATION record with dosage/frequency fields", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, {
      recordType: "MEDICATION",
      providerId: provider.id,
      title: "Antibiotics",
      recordedAt: "2026-01-15T09:30:00+00:00",
      details: { medicationName: "Amoxicillin", dosage: "250mg", frequency: "Twice daily", duration: "7 days" },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { medicalRecord: { details: Record<string, unknown> } };
    expect(json.medicalRecord.details.medicationName).toBe("Amoxicillin");
  });

  it("rejects a VACCINATION record missing the required vaccineName", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, {
      recordType: "VACCINATION",
      providerId: provider.id,
      title: "Rabies vaccine",
      recordedAt: "2026-01-15T09:30:00+00:00",
      details: { administeredAt: "2026-01-15" },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/pets/:petId/medical-records — listing", () => {
  it("lets the owner list their pet's records", async () => {
    const { owner, provider, pet, customer } = await setupTreatedPet();
    await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));

    const res = await app.request(`/api/pets/${pet.id}/medical-records`, { headers: { cookie: customer.cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { medicalRecords: unknown[] };
    expect(json.medicalRecords).toHaveLength(1);
  });

  it("excludes archived records by default and includes them with ?includeArchived=true", async () => {
    const { owner, provider, pet, customer } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };
    await app.request(`/api/medical-records/${medicalRecord.id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ reason: "duplicate entry" }),
    });

    const defaultRes = await app.request(`/api/pets/${pet.id}/medical-records`, { headers: { cookie: customer.cookie } });
    const defaultJson = (await defaultRes.json()) as { medicalRecords: unknown[] };
    expect(defaultJson.medicalRecords).toHaveLength(0);

    const includeRes = await app.request(`/api/pets/${pet.id}/medical-records?includeArchived=true`, {
      headers: { cookie: customer.cookie },
    });
    const includeJson = (await includeRes.json()) as { medicalRecords: unknown[] };
    expect(includeJson.medicalRecords).toHaveLength(1);
  });

  it("filters by recordType", async () => {
    const { owner, provider, pet, customer } = await setupTreatedPet();
    await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    await createRecord(owner.cookie, pet.id, {
      recordType: "VACCINATION",
      providerId: provider.id,
      title: "Rabies",
      recordedAt: "2026-01-15T09:30:00+00:00",
      details: { vaccineName: "Rabies", administeredAt: "2026-01-15" },
    });

    const res = await app.request(`/api/pets/${pet.id}/medical-records?recordType=VACCINATION`, {
      headers: { cookie: customer.cookie },
    });
    const json = (await res.json()) as { medicalRecords: { recordType: string }[] };
    expect(json.medicalRecords).toHaveLength(1);
    expect(json.medicalRecords[0].recordType).toBe("VACCINATION");
  });
});

describe("PATCH /api/medical-records/:id — amendment", () => {
  it("lets the authoring provider correct the title/description/details", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    const res = await app.request(`/api/medical-records/${medicalRecord.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ title: "Annual checkup (corrected)", details: { diagnosis: "Updated diagnosis" } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { medicalRecord: { title: string; details: Record<string, unknown> } };
    expect(json.medicalRecord.title).toBe("Annual checkup (corrected)");
    expect(json.medicalRecord.details.diagnosis).toBe("Updated diagnosis");
  });

  it("rejects details that don't match the record's own type with a clean 400, not a 500", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, {
      recordType: "VACCINATION",
      providerId: provider.id,
      title: "Rabies",
      recordedAt: "2026-01-15T09:30:00+00:00",
      details: { vaccineName: "Rabies", administeredAt: "2026-01-15" },
    });
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    const res = await app.request(`/api/medical-records/${medicalRecord.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      // A MEDICATION-shaped details object on a VACCINATION record —
      // missing the required vaccineName/administeredAt.
      body: JSON.stringify({ details: { medicationName: "Amoxicillin", dosage: "250mg", frequency: "Daily" } }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { fields?: Record<string, unknown> };
    expect(json.fields).toBeTruthy();
  });

  it("never allows petId/providerId/createdByUserId/createdAt to be changed via PATCH", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord: created } = (await createRes.json()) as { medicalRecord: Record<string, unknown> };

    const res = await app.request(`/api/medical-records/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({
        petId: "11111111-1111-1111-1111-111111111111",
        providerId: "22222222-2222-2222-2222-222222222222",
        createdByUserId: "33333333-3333-3333-3333-333333333333",
        title: "Still allowed to change title",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { medicalRecord: Record<string, unknown> };
    expect(json.medicalRecord.petId).toBe(created.petId);
    expect(json.medicalRecord.providerId).toBe(created.providerId);
    expect(json.medicalRecord.createdByUserId).toBe(created.createdByUserId);
  });

  it("returns 400 for an empty patch body", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    const res = await app.request(`/api/medical-records/${medicalRecord.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/medical-records/:id/archive — lifecycle", () => {
  it("archives an active record and rejects archiving twice", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    const res = await app.request(`/api/medical-records/${medicalRecord.id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ reason: "recorded in error" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { medicalRecord: { status: string; archivedAt: string | null } };
    expect(json.medicalRecord.status).toBe("ARCHIVED");
    expect(json.medicalRecord.archivedAt).not.toBeNull();

    const secondRes = await app.request(`/api/medical-records/${medicalRecord.id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({}),
    });
    expect(secondRes.status).toBe(409);
  });

  it("there is no DELETE endpoint for a medical record", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    const res = await app.request(`/api/medical-records/${medicalRecord.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });
    expect(res.status).toBe(404);

    const row = await db.query.medicalRecords.findFirst({ where: eq(medicalRecords.id, medicalRecord.id) });
    expect(row).toBeTruthy();
  });

  it("deleting a pet with medical records is rejected with a clean 409, never a raw DB error", async () => {
    const { customer, owner, provider, pet } = await setupTreatedPet();
    await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));

    const res = await app.request(`/api/pets/${pet.id}`, { method: "DELETE", headers: { cookie: customer.cookie } });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).not.toMatch(/relation|constraint|violates/i);
  });
});

describe("admin has no special medical-record access (deliberate scope decision)", () => {
  it("an admin with no treating relationship still gets 404 for an unrelated pet's records", async () => {
    const { pet } = await setupTreatedPet();
    const admin = await asAdmin();
    const res = await app.request(`/api/pets/${pet.id}/medical-records`, { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(404);
  });
});
