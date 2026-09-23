import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, registerAndLogin } from "./test-helpers.js";
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
    body: JSON.stringify({ businessName: "Security Test Vet", providerType: "VET", timezone: "UTC", ...overrides }),
  });
  const { provider } = (await res.json()) as { provider: { id: string } };
  return provider;
}

async function createService(cookie: string, providerId: string) {
  const res = await app.request(`/api/providers/${providerId}/services`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name: "Checkup", durationMinutes: 60, priceMinor: 5000, currency: "INR" }),
  });
  const { service } = (await res.json()) as { service: { id: string } };
  return service;
}

async function createRule(cookie: string, providerId: string) {
  await app.request(`/api/providers/${providerId}/availability/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }),
  });
}

async function createPet(cookie: string, name = "Rex") {
  const res = await app.request("/api/pets", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name, species: "Dog" }),
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
  const { booking } = (await res.json()) as { booking: { id: string } };
  return booking;
}

async function payBooking(cookie: string, bookingId: string) {
  await app.request(`/api/bookings/${bookingId}/payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({}),
  });
}

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

function visitBody(overrides: Record<string, unknown> = {}) {
  return {
    recordType: "VISIT",
    title: "Annual checkup",
    recordedAt: "2026-01-15T09:30:00+00:00",
    details: { observations: "Healthy" },
    ...overrides,
  };
}

async function createRecord(cookie: string, petId: string, body: Record<string, unknown>) {
  return app.request(`/api/pets/${petId}/medical-records`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function countAuthDeniedEvents(actorUserId: string) {
  const rows = await db.query.auditLogs.findMany({
    where: and(eq(auditLogs.actorUserId, actorUserId), eq(auditLogs.action, "AUTHORIZATION_DENIED")),
  });
  return rows.length;
}

// ---------------------------------------------------------------------
// Section 26 — the mandatory security matrix.
// ---------------------------------------------------------------------
describe("medical records — authorization matrix", () => {
  it("Customer A -> own pet: allowed", async () => {
    const { owner, provider, pet, customer } = await setupTreatedPet();
    await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const res = await app.request(`/api/pets/${pet.id}/medical-records`, { headers: { cookie: customer.cookie } });
    expect(res.status).toBe(200);
  });

  it("Customer A -> Customer B's pet: denied (404, not 403)", async () => {
    const { pet } = await setupTreatedPet();
    const strangerCustomer = await asUser();
    const res = await app.request(`/api/pets/${pet.id}/medical-records`, { headers: { cookie: strangerCustomer.cookie } });
    expect(res.status).toBe(404);
  });

  it("Provider A -> legitimately treated pet: allowed", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    expect(res.status).toBe(201);
  });

  it("Provider A -> unrelated pet: denied", async () => {
    const strangerProvider = await asUser();
    await createProvider(strangerProvider.cookie);
    const untreatedCustomer = await asUser();
    const untreatedPet = await createPet(untreatedCustomer.cookie);

    const res = await createRecord(strangerProvider.cookie, untreatedPet.id, visitBody());
    expect(res.status).toBe(404);
  });

  it("Provider A -> Provider B's pet (Provider B has the real relationship): denied", async () => {
    const treated = await setupTreatedPet();
    const providerB = await asUser();
    await createProvider(providerB.cookie);

    const res = await app.request(`/api/pets/${treated.pet.id}/medical-records`, { headers: { cookie: providerB.cookie } });
    expect(res.status).toBe(404);
  });

  it("Provider A -> Provider B's medical record (direct record id): denied", async () => {
    const treated = await setupTreatedPet();
    const createRes = await createRecord(treated.owner.cookie, treated.pet.id, visitBody({ providerId: treated.provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    const providerB = await asUser();
    await createProvider(providerB.cookie);
    const res = await app.request(`/api/medical-records/${medicalRecord.id}`, { headers: { cookie: providerB.cookie } });
    expect(res.status).toBe(404);
  });

  it("Customer -> provider-only mutation (POST create): denied with 403, not silently allowed", async () => {
    const { customer, pet } = await setupTreatedPet();
    const res = await createRecord(customer.cookie, pet.id, visitBody());
    expect(res.status).toBe(403);
  });

  it("Provider -> customer-owned pet without a legitimate relationship: denied", async () => {
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const someProvider = await asUser();
    await createProvider(someProvider.cookie);

    const res = await createRecord(someProvider.cookie, pet.id, visitBody());
    expect(res.status).toBe(404);
  });

  it("Fake provider ID in the create body: rejected, not silently used", async () => {
    const { owner, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, visitBody({ providerId: "11111111-1111-1111-1111-111111111111" }));
    expect(res.status).toBe(403);
  });

  it("Fake createdByUserId is ignored — the actor is always the session user", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id, createdByUserId: "22222222-2222-2222-2222-222222222222" }));
    const json = (await res.json()) as { medicalRecord: { createdByUserId: string } };
    expect(json.medicalRecord.createdByUserId).toBe(owner.userId);
  });

  it("Fake booking ID (belongs to nothing): denied", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id, bookingId: "33333333-3333-3333-3333-333333333333" }));
    expect(res.status).toBe(400);
  });

  it("Cross-provider booking (Provider A + Pet B + Booking belonging to Provider C): denied", async () => {
    const treatedByA = await setupTreatedPet();
    const treatedByC = await setupTreatedPet();

    const res = await createRecord(
      treatedByA.owner.cookie,
      treatedByA.pet.id,
      visitBody({ providerId: treatedByA.provider.id, bookingId: treatedByC.booking.id }),
    );
    expect(res.status).toBe(400);
  });

  it("record enumeration: sequential/random record IDs never disclose unauthorized content", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));

    const stranger = await asUser();
    const randomIds = [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    ];
    for (const id of randomIds) {
      const res = await app.request(`/api/medical-records/${id}`, { headers: { cookie: stranger.cookie } });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toMatch(/checkup|vaccine|diagnosis|healthy/i);
    }
  });

  it("a pet ID alone is never an authorization credential — knowing it doesn't grant a stranger read access", async () => {
    const { pet } = await setupTreatedPet();
    const stranger = await asUser();
    const res = await app.request(`/api/pets/${pet.id}/medical-records`, { headers: { cookie: stranger.cookie } });
    expect(res.status).toBe(404);
  });

  it("PENDING (unpaid) bookings do not establish a legitimate relationship", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday()}T09:00:00+00:00`);
    // Deliberately never paid — booking stays PENDING.

    // The provider owner is not the pet's owner and has no CONFIRMED/
    // COMPLETED booking yet, so this is indistinguishable from any other
    // unrelated caller — hidden behind the same 404.
    const res = await createRecord(owner.cookie, pet.id, visitBody());
    expect(res.status).toBe(404);
  });

  it("CANCELLED bookings do not establish a legitimate relationship", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday()}T09:00:00+00:00`);
    await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: customer.cookie } });

    const res = await createRecord(owner.cookie, pet.id, visitBody());
    expect(res.status).toBe(404);
  });

  it("only the authoring provider (not a different, also-legitimate provider) may update a record", async () => {
    const { owner: ownerA, provider: providerA, pet, customer } = await setupTreatedPet();
    const createRes = await createRecord(ownerA.cookie, pet.id, visitBody({ providerId: providerA.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    // A second provider also legitimately treats the same pet (a separate
    // CONFIRMED booking, booked by the pet's actual owner).
    const ownerB = await asUser();
    const providerB = await createProvider(ownerB.cookie);
    const serviceB = await createService(ownerB.cookie, providerB.id);
    await createRule(ownerB.cookie, providerB.id);
    const bookingB = await createBooking(customer.cookie, providerB.id, serviceB.id, pet.id, `${futureMonday(1)}T09:00:00+00:00`);
    await payBooking(customer.cookie, bookingB.id);

    // Provider B can read the record (continuity of care)...
    const readRes = await app.request(`/api/medical-records/${medicalRecord.id}`, { headers: { cookie: ownerB.cookie } });
    expect(readRes.status).toBe(200);

    // ...but cannot update it — only Provider A (the author) may.
    const res = await app.request(`/api/medical-records/${medicalRecord.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: ownerB.cookie },
      body: JSON.stringify({ title: "hijacked" }),
    });
    expect(res.status).toBe(403);
  });

  it("a pet owner cannot silently alter a provider-authored record", async () => {
    const { owner, provider, pet, customer } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    const res = await app.request(`/api/medical-records/${medicalRecord.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: JSON.stringify({ title: "rewritten by owner" }),
    });
    expect(res.status).toBe(403);
  });

  it("a pet owner cannot archive a provider-authored record", async () => {
    const { owner, provider, pet, customer } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    const res = await app.request(`/api/medical-records/${medicalRecord.id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a huge details field without crashing (injection-of-huge-text hardening)", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const res = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id, description: "x".repeat(1_000_000) }));
    expect(res.status).toBe(400);
  });

  it("rejects a request body that is an array instead of an object", async () => {
    const { owner, pet } = await setupTreatedPet();
    const res = await app.request(`/api/pets/${pet.id}/medical-records`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(400);
  });

  it("an authenticated user with no session cookie is rejected", async () => {
    const { pet } = await setupTreatedPet();
    const res = await app.request(`/api/pets/${pet.id}/medical-records`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------
// Section 27/28 — audit trail.
// ---------------------------------------------------------------------
describe("medical records — audit trail", () => {
  it("creating a record writes a MEDICAL_RECORD_CREATED audit event", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    const events = await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.resourceId, medicalRecord.id), eq(auditLogs.action, "MEDICAL_RECORD_CREATED")),
    });
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(owner.userId);
    expect(events[0].petId).toBe(pet.id);
    // No medical content duplicated into the audit log.
    expect(JSON.stringify(events[0].metadata ?? {})).not.toMatch(/checkup|healthy/i);
  });

  it("an authorized detail view writes a MEDICAL_RECORD_VIEWED event", async () => {
    const { owner, provider, pet, customer } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    await app.request(`/api/medical-records/${medicalRecord.id}`, { headers: { cookie: customer.cookie } });

    const events = await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.resourceId, medicalRecord.id), eq(auditLogs.action, "MEDICAL_RECORD_VIEWED")),
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].actorUserId).toBe(customer.userId);
  });

  it("listing a pet's medical records also writes a MEDICAL_RECORD_VIEWED event, without duplicating content into it", async () => {
    const { owner, provider, pet, customer } = await setupTreatedPet();
    await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id, title: "Confidential title text" }));

    const before = await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.petId, pet.id), eq(auditLogs.action, "MEDICAL_RECORD_VIEWED")),
    });
    const res = await app.request(`/api/pets/${pet.id}/medical-records`, { headers: { cookie: customer.cookie } });
    expect(res.status).toBe(200);

    const after = await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.petId, pet.id), eq(auditLogs.action, "MEDICAL_RECORD_VIEWED")),
    });
    expect(after.length).toBe(before.length + 1);
    const listEvent = after[after.length - 1];
    expect(listEvent.actorUserId).toBe(customer.userId);
    expect(JSON.stringify(listEvent.metadata ?? {})).not.toMatch(/Confidential title text/);
  });

  it("updating a record writes a MEDICAL_RECORD_UPDATED event with only field names, never content, in metadata", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    await app.request(`/api/medical-records/${medicalRecord.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ title: "Updated title with secret diagnosis details XYZ" }),
    });

    const events = await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.resourceId, medicalRecord.id), eq(auditLogs.action, "MEDICAL_RECORD_UPDATED")),
    });
    expect(events).toHaveLength(1);
    const metadata = events[0].metadata as { changedFields?: string[] };
    expect(metadata.changedFields).toContain("title");
    expect(JSON.stringify(metadata)).not.toMatch(/secret diagnosis details XYZ/);
  });

  it("archiving a record writes a MEDICAL_RECORD_ARCHIVED event", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    await app.request(`/api/medical-records/${medicalRecord.id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({}),
    });

    const events = await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.resourceId, medicalRecord.id), eq(auditLogs.action, "MEDICAL_RECORD_ARCHIVED")),
    });
    expect(events).toHaveLength(1);
  });

  it("unauthorized access attempts write AUTHORIZATION_DENIED events without leaking medical content", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    const stranger = await asUser();
    const before = await countAuthDeniedEvents(stranger.userId);
    const res = await app.request(`/api/medical-records/${medicalRecord.id}`, { headers: { cookie: stranger.cookie } });
    expect(res.status).toBe(404);
    const after = await countAuthDeniedEvents(stranger.userId);
    expect(after).toBe(before + 1);

    const events = await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.actorUserId, stranger.userId), eq(auditLogs.action, "AUTHORIZATION_DENIED")),
    });
    expect(JSON.stringify(events.map((e) => e.metadata))).not.toMatch(/checkup|healthy/i);
  });

  it("there is no HTTP endpoint to update or delete an audit log entry", async () => {
    const { owner, provider, pet } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };
    const events = await db.query.auditLogs.findMany({ where: eq(auditLogs.resourceId, medicalRecord.id) });
    const anyEventId = events[0]?.id;
    expect(anyEventId).toBeTruthy();

    const patchRes = await app.request(`/api/audit-logs/${anyEventId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ action: "MEDICAL_RECORD_VIEWED" }),
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await app.request(`/api/audit-logs/${anyEventId}`, { method: "DELETE", headers: { cookie: owner.cookie } });
    expect(deleteRes.status).toBe(404);
  });

  it("concurrent create + update + read against the same record produce a deterministic, fully attributed audit trail", async () => {
    const { owner, provider, pet, customer } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord } = (await createRes.json()) as { medicalRecord: { id: string } };

    await Promise.all([
      app.request(`/api/medical-records/${medicalRecord.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ title: "Concurrent update" }),
      }),
      app.request(`/api/medical-records/${medicalRecord.id}`, { headers: { cookie: customer.cookie } }),
    ]);

    const events = await db.query.auditLogs.findMany({ where: eq(auditLogs.resourceId, medicalRecord.id) });
    const actions = events.map((e) => e.action).sort();
    expect(actions).toContain("MEDICAL_RECORD_CREATED");
    expect(actions).toContain("MEDICAL_RECORD_UPDATED");
    expect(actions).toContain("MEDICAL_RECORD_VIEWED");
    // Every event carries its own database-generated timestamp and id —
    // ordering is derivable from created_at/id, never from in-process
    // JS timing.
    for (const e of events) {
      expect(e.id).toBeTruthy();
      expect(e.createdAt).toBeInstanceOf(Date);
    }
  });
});

// ---------------------------------------------------------------------
// Section 29 — historical integrity.
// ---------------------------------------------------------------------
describe("medical records — historical integrity", () => {
  it("create -> read -> update preserves original authorship/pet/provider identity end to end", async () => {
    const { owner, provider, pet, customer } = await setupTreatedPet();
    const createRes = await createRecord(owner.cookie, pet.id, visitBody({ providerId: provider.id }));
    const { medicalRecord: created } = (await createRes.json()) as { medicalRecord: Record<string, unknown> };

    const readRes = await app.request(`/api/medical-records/${created.id}`, { headers: { cookie: customer.cookie } });
    expect(readRes.status).toBe(200);

    const updateRes = await app.request(`/api/medical-records/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ description: "Corrected description" }),
    });
    const { medicalRecord: updated } = (await updateRes.json()) as { medicalRecord: Record<string, unknown> };

    expect(updated.id).toBe(created.id);
    expect(updated.petId).toBe(created.petId);
    expect(updated.providerId).toBe(created.providerId);
    expect(updated.createdByUserId).toBe(created.createdByUserId);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.description).toBe("Corrected description");
  });
});
