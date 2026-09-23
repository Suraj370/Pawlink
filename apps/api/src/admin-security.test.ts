import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray, or } from "drizzle-orm";
import { createTestApp, promoteToAdmin, registerAndLogin } from "./test-helpers.js";
import { auditLogs, bookings, medicalRecords, pets, payments, providers, reviews, users } from "./db/schema.js";

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
    const ownedPets = await db.query.pets.findMany({ where: inArray(pets.ownerId, userIds) });
    const petIds = ownedPets.map((p) => p.id);

    await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, userIds));
    // medical_records is RESTRICT on pet_id/provider_id/created_by_user_id
    // — must be cleared before pets/providers/users can be deleted.
    if (petIds.length > 0 || providerIds.length > 0 || userIds.length > 0) {
      await db
        .delete(medicalRecords)
        .where(
          or(
            petIds.length > 0 ? inArray(medicalRecords.petId, petIds) : undefined,
            providerIds.length > 0 ? inArray(medicalRecords.providerId, providerIds) : undefined,
            inArray(medicalRecords.createdByUserId, userIds),
          ),
        );
    }
    if (bookingIds.length > 0) {
      await db.delete(reviews).where(inArray(reviews.bookingId, bookingIds));
      await db.delete(payments).where(inArray(payments.bookingId, bookingIds));
    }
    if (providerIds.length > 0) {
      await db.delete(reviews).where(inArray(reviews.providerId, providerIds));
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

async function createProvider(cookie: string) {
  const res = await app.request("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ businessName: "Admin Security Vet", providerType: "VET", timezone: "UTC" }),
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

async function completeBooking(cookie: string, bookingId: string) {
  return app.request(`/api/bookings/${bookingId}/complete`, { method: "POST", headers: { cookie } });
}

async function setupCompletedBooking(monday = futureMonday()) {
  const owner = await asUser();
  const provider = await createProvider(owner.cookie);
  const service = await createService(owner.cookie, provider.id);
  await createRule(owner.cookie, provider.id);
  const customer = await asUser();
  const pet = await createPet(customer.cookie);
  const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${monday}T09:00:00+00:00`);
  await payBooking(customer.cookie, booking.id);
  await completeBooking(owner.cookie, booking.id);
  return { owner, provider, service, customer, pet, booking, monday };
}

async function createReviewFixture(cookie: string, bookingId: string) {
  return app.request(`/api/bookings/${bookingId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ rating: 5 }),
  });
}

// ---------------------------------------------------------------------
// Section 22 — every admin endpoint: anonymous/customer/provider denied,
// admin allowed.
// ---------------------------------------------------------------------
const ADMIN_GET_ENDPOINTS = [
  "/api/admin/dashboard",
  "/api/admin/providers",
  "/api/admin/users",
  "/api/admin/bookings",
  "/api/admin/payments",
  "/api/admin/reviews",
  "/api/admin/audit",
];

describe("admin API authorization matrix", () => {
  for (const path of ADMIN_GET_ENDPOINTS) {
    it(`${path}: anonymous -> 401, customer -> 403, provider owner -> 403, admin -> 200`, async () => {
      const anonymousRes = await app.request(path);
      expect(anonymousRes.status).toBe(401);

      const customer = await asUser();
      const customerRes = await app.request(path, { headers: { cookie: customer.cookie } });
      expect(customerRes.status).toBe(403);

      const owner = await asUser();
      await createProvider(owner.cookie);
      const ownerRes = await app.request(path, { headers: { cookie: owner.cookie } });
      expect(ownerRes.status).toBe(403);

      const admin = await asAdmin();
      const adminRes = await app.request(path, { headers: { cookie: admin.cookie } });
      expect(adminRes.status).toBe(200);
    });
  }

  it("a role forged in the request body/header is never honored — the server only trusts the session", async () => {
    const customer = await asUser();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);

    const res = await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: customer.cookie, "X-User-Role": "ADMIN" },
      body: JSON.stringify({ status: "SUSPENDED", role: "ADMIN" }),
    });
    expect(res.status).toBe(403);

    const row = await db.query.providers.findFirst({ where: eq(providers.id, provider.id) });
    expect(row?.status).toBe("ACTIVE");
  });

  it("POST /api/admin/providers/:id/status: customer/provider denied, admin allowed", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);

    const customer = await asUser();
    const customerRes = await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });
    expect(customerRes.status).toBe(403);

    const ownerRes = await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });
    expect(ownerRes.status).toBe(403);

    const admin = await asAdmin();
    const adminRes = await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });
    expect(adminRes.status).toBe(200);
  });

  it("POST /api/admin/reviews/:id/hide and /publish: provider and customer denied, admin allowed", async () => {
    const { owner, customer, booking } = await setupCompletedBooking();
    const createRes = await createReviewFixture(customer.cookie, booking.id);
    const { review } = (await createRes.json()) as { review: { id: string } };

    const providerAttempt = await app.request(`/api/admin/reviews/${review.id}/hide`, {
      method: "POST",
      headers: { cookie: owner.cookie },
    });
    expect(providerAttempt.status).toBe(403);

    const customerAttempt = await app.request(`/api/admin/reviews/${review.id}/hide`, {
      method: "POST",
      headers: { cookie: customer.cookie },
    });
    expect(customerAttempt.status).toBe(403);

    // A different, unrelated customer also cannot hide someone else's review.
    const strangerCustomer = await asUser();
    const strangerAttempt = await app.request(`/api/admin/reviews/${review.id}/hide`, {
      method: "POST",
      headers: { cookie: strangerCustomer.cookie },
    });
    expect(strangerAttempt.status).toBe(403);

    const admin = await asAdmin();
    const adminRes = await app.request(`/api/admin/reviews/${review.id}/hide`, {
      method: "POST",
      headers: { cookie: admin.cookie },
    });
    expect(adminRes.status).toBe(200);

    const row = await db.query.reviews.findFirst({ where: eq(reviews.id, review.id) });
    expect(row?.status).toBe("HIDDEN");
  });
});

// ---------------------------------------------------------------------
// Section 23/27 — IDOR / audit-log immutability through the admin
// surface specifically.
// ---------------------------------------------------------------------
describe("audit log immutability via the admin surface", () => {
  it("admin can read audit logs but there is no route to modify or delete one", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });

    const listRes = await app.request("/api/admin/audit?action=PROVIDER_STATUS_CHANGED", { headers: { cookie: admin.cookie } });
    expect(listRes.status).toBe(200);
    const json = (await listRes.json()) as { entries: { id: string }[] };
    const entryId = json.entries[0]?.id;
    expect(entryId).toBeTruthy();

    const patchRes = await app.request(`/api/admin/audit/${entryId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ action: "AUTHORIZATION_DENIED" }),
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await app.request(`/api/admin/audit/${entryId}`, { method: "DELETE", headers: { cookie: admin.cookie } });
    expect(deleteRes.status).toBe(404);
  });

  it("a customer and a provider cannot read audit logs at all", async () => {
    const customer = await asUser();
    const owner = await asUser();
    await createProvider(owner.cookie);

    const customerRes = await app.request("/api/admin/audit", { headers: { cookie: customer.cookie } });
    expect(customerRes.status).toBe(403);
    const ownerRes = await app.request("/api/admin/audit", { headers: { cookie: owner.cookie } });
    expect(ownerRes.status).toBe(403);
  });
});

// ---------------------------------------------------------------------
// Section 39 — medical-record isolation. Admin operational access does
// NOT imply medical-record access.
// ---------------------------------------------------------------------
describe("medical-record isolation from the admin surface", () => {
  it("there is no /api/admin/medical-records route", async () => {
    const admin = await asAdmin();
    const res = await app.request("/api/admin/medical-records", { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(404);
  });

  it("there is no way to list or browse medical records via any admin endpoint", async () => {
    const admin = await asAdmin();
    for (const path of ["/api/admin/pets", "/api/admin/medical-records", "/api/admin/records"]) {
      const res = await app.request(path, { headers: { cookie: admin.cookie } });
      expect(res.status).toBe(404);
    }
  });

  it("an admin who never treated a pet still cannot read its medical records through the existing medical-records API", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday(10)}T09:00:00+00:00`);
    await payBooking(customer.cookie, booking.id);
    await completeBooking(owner.cookie, booking.id);
    await app.request(`/api/pets/${pet.id}/medical-records`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({
        recordType: "VISIT",
        title: "Confidential visit notes",
        recordedAt: "2026-01-15T09:30:00+00:00",
        details: { observations: "Sensitive clinical detail" },
      }),
    });

    const res = await app.request(`/api/pets/${pet.id}/medical-records`, { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(404);
  });

  it("audit entries for medical-record actions, visible through /api/admin/audit, never carry the record's clinical content", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday(11)}T09:00:00+00:00`);
    await payBooking(customer.cookie, booking.id);
    await completeBooking(owner.cookie, booking.id);
    const createRes = await app.request(`/api/pets/${pet.id}/medical-records`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({
        recordType: "DIAGNOSIS",
        title: "TopSecretDiagnosisTitleXYZ",
        recordedAt: "2026-01-15T09:30:00+00:00",
        details: { diagnosis: "ClassifiedClinicalDetailABC" },
      }),
    });
    expect(createRes.status).toBe(201);

    const auditRes = await app.request("/api/admin/audit?action=MEDICAL_RECORD_CREATED&pageSize=50", { headers: { cookie: admin.cookie } });
    const auditJson = (await auditRes.json()) as { entries: { metadata: Record<string, unknown> | null }[] };
    const serialized = JSON.stringify(auditJson.entries);
    expect(serialized).not.toMatch(/TopSecretDiagnosisTitleXYZ/);
    expect(serialized).not.toMatch(/ClassifiedClinicalDetailABC/);
  });
});

// ---------------------------------------------------------------------
// Section 30/38 — filter validation, SQL-injection-shaped input, huge
// filters.
// ---------------------------------------------------------------------
describe("admin search/filter hardening", () => {
  it("a SQL-injection-shaped search string is treated as a literal, parameterized value, never breaks or leaks extra rows", async () => {
    const admin = await asAdmin();
    const res = await app.request(`/api/admin/providers?search=${encodeURIComponent("' OR '1'='1")}`, {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { providers: unknown[] };
    expect(Array.isArray(json.providers)).toBe(true);
  });

  it("rejects a malformed providerId filter (not a UUID)", async () => {
    const admin = await asAdmin();
    const res = await app.request("/api/admin/bookings?providerId=not-a-uuid", { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed date filter", async () => {
    const admin = await asAdmin();
    const res = await app.request("/api/admin/bookings?dateFrom=not-a-date", { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(400);
  });

  it("an oversized search string is rejected, not silently truncated into a query", async () => {
    const admin = await asAdmin();
    const res = await app.request(`/api/admin/providers?search=${"x".repeat(5000)}`, { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(400);
  });

  it("an absurd pageSize is clamped to the schema's own bound, never passed through raw", async () => {
    const admin = await asAdmin();
    const res = await app.request("/api/admin/providers?pageSize=999999999", { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pageSize: number; providers: unknown[] };
    expect(json.pageSize).toBeLessThanOrEqual(100);
    expect(json.providers.length).toBeLessThanOrEqual(100);
  });

  it("rejects an invalid action value on the audit filter", async () => {
    const admin = await asAdmin();
    const res = await app.request("/api/admin/audit?action=NOT_A_REAL_ACTION", { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------
// Section 14 — payment mutation restriction.
// ---------------------------------------------------------------------
describe("payment mutation restriction", () => {
  it("there is no admin endpoint that can set a payment's status", async () => {
    const admin = await asAdmin();
    const { booking } = await setupCompletedBooking(futureMonday(12));
    const paymentRow = await db.query.payments.findFirst({ where: eq(payments.bookingId, booking.id) });

    for (const method of ["PATCH", "PUT", "POST"] as const) {
      const res = await app.request(`/api/admin/payments/${paymentRow!.id}`, {
        method,
        headers: { "Content-Type": "application/json", cookie: admin.cookie },
        body: JSON.stringify({ status: "SUCCEEDED" }),
      });
      expect(res.status).toBe(404);
    }

    const row = await db.query.payments.findFirst({ where: eq(payments.id, paymentRow!.id) });
    expect(row?.status).toBe("SUCCEEDED"); // unchanged (already succeeded from the real payment flow)
  });
});
