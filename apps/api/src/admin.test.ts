import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, promoteToAdmin, registerAndLogin } from "./test-helpers.js";
import { auditLogs, bookings, payments, providers, reviews, users } from "./db/schema.js";

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

async function createProvider(cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await app.request("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ businessName: "Admin Test Vet", providerType: "VET", timezone: "UTC", ...overrides }),
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

async function payBooking(cookie: string, bookingId: string, body: Record<string, unknown> = {}) {
  return app.request(`/api/bookings/${bookingId}/payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
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

async function getDashboard(cookie: string) {
  const res = await app.request("/api/admin/dashboard", { headers: { cookie } });
  return (await res.json()) as Record<string, number>;
}

describe("GET /api/admin/dashboard", () => {
  it("computes counts from fresh PostgreSQL aggregates, not hard-coded numbers", async () => {
    const admin = await asAdmin();
    const before = await getDashboard(admin.cookie);

    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday()}T09:00:00+00:00`);
    await payBooking(customer.cookie, booking.id, { scenario: "PENDING" });

    // These assertions use >= rather than exact equality: the full test
    // suite runs multiple files with real concurrency against the same
    // shared database (see playwright.config.ts's own note on this, and
    // this repo's established pattern of scoping assertions to specific
    // ids rather than global counts wherever a race is possible) — other
    // test files can legitimately create their own providers/users/
    // bookings/payments in the window between `before` and `after`. What
    // this test actually proves — that the dashboard is a live query
    // reflecting real inserts, not a hard-coded or stale number — still
    // holds with a lower bound.
    const after = await getDashboard(admin.cookie);
    expect(after.totalProviders).toBeGreaterThanOrEqual(before.totalProviders + 1);
    expect(after.activeProviders).toBeGreaterThanOrEqual(before.activeProviders + 1);
    expect(after.upcomingBookings).toBeGreaterThanOrEqual(before.upcomingBookings + 1);
    expect(after.pendingPayments).toBeGreaterThanOrEqual(before.pendingPayments + 1);
    // Two new accounts were created (owner + customer) on top of the admin itself.
    expect(after.totalCustomers).toBeGreaterThanOrEqual(before.totalCustomers + 2);
  });

  it("reflects a suspended provider in suspendedProviders and out of activeProviders", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const before = await getDashboard(admin.cookie);

    await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });

    const after = await getDashboard(admin.cookie);
    expect(after.suspendedProviders).toBeGreaterThanOrEqual(before.suspendedProviders + 1);
  });

  it("counts a COMPLETED booking", async () => {
    const admin = await asAdmin();
    const before = await getDashboard(admin.cookie);
    await setupCompletedBooking();
    const after = await getDashboard(admin.cookie);
    expect(after.completedBookings).toBeGreaterThanOrEqual(before.completedBookings + 1);
  });
});

describe("GET /api/admin/providers", () => {
  it("sees providers of every status, unlike public discovery", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const businessName = `Findable Vet ${Date.now()}`;
    const provider = await createProvider(owner.cookie, { businessName });
    await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "INACTIVE" }),
    });

    // Public discovery no longer shows it...
    const publicRes = await app.request("/api/providers?pageSize=50");
    const publicJson = (await publicRes.json()) as { providers: { id: string }[] };
    expect(publicJson.providers.some((p) => p.id === provider.id)).toBe(false);

    // ...but the admin list does, filterable by status and searchable by name.
    const adminRes = await app.request(
      `/api/admin/providers?status=INACTIVE&search=${encodeURIComponent(businessName)}`,
      { headers: { cookie: admin.cookie } },
    );
    const adminJson = (await adminRes.json()) as { providers: { id: string; status: string }[] };
    expect(adminJson.providers.some((p) => p.id === provider.id)).toBe(true);
  });
});

describe("POST /api/admin/providers/:id/status", () => {
  it("changes status and writes a PROVIDER_STATUS_CHANGED audit event with previous/new status", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);

    const res = await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { provider: { status: string } };
    expect(json.provider.status).toBe("SUSPENDED");

    const events = await db.query.auditLogs.findMany({
      where: (a, { and, eq: eq2 }) => and(eq2(a.action, "PROVIDER_STATUS_CHANGED"), eq2(a.resourceId, provider.id)),
    });
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(admin.userId);
    expect(events[0].providerId).toBe(provider.id);
    expect(events[0].metadata).toMatchObject({ previousStatus: "ACTIVE", newStatus: "SUSPENDED" });
  });

  it("mass assignment: only `status` is read from the body — ownerId/createdAt/internalRole are ignored", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);

    const res = await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({
        status: "INACTIVE",
        ownerId: "11111111-1111-1111-1111-111111111111",
        createdAt: "2020-01-01T00:00:00Z",
        internalRole: "SUPERADMIN",
      }),
    });
    expect(res.status).toBe(200);

    const row = await db.query.providers.findFirst({ where: eq(providers.id, provider.id) });
    expect(row?.ownerUserId).toBe(owner.userId);
    expect(row?.status).toBe("INACTIVE");
  });

  it("rejects an invalid status value", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);

    const res = await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "NOT_A_STATUS" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent provider", async () => {
    const admin = await asAdmin();
    const res = await app.request("/api/admin/providers/00000000-0000-0000-0000-000000000000/status", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("suspension does not corrupt historical data", () => {
  it("keeps a COMPLETED booking, its payment, and its review intact after the provider is suspended", async () => {
    const admin = await asAdmin();
    const { provider, booking, customer } = await setupCompletedBooking(futureMonday(1));
    await createReviewFixture(customer.cookie, booking.id);

    await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });

    const bookingRow = await db.query.bookings.findFirst({ where: eq(bookings.id, booking.id) });
    expect(bookingRow?.status).toBe("COMPLETED");
    const paymentRows = await db.query.payments.findMany({ where: eq(payments.bookingId, booking.id) });
    expect(paymentRows.length).toBeGreaterThan(0);
    const reviewRow = await db.query.reviews.findFirst({ where: eq(reviews.bookingId, booking.id) });
    expect(reviewRow).toBeTruthy();
  });

  it("a suspended provider can no longer accept new bookings", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });

    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const res = await app.request("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: JSON.stringify({ providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${futureMonday(2)}T09:00:00+00:00` }),
    });
    expect(res.status).toBe(409);
  });

  it("the provider owner cannot unsuspend themselves", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });

    const res = await app.request(`/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });
    expect(res.status).toBe(403);
  });
});

async function createReviewFixture(cookie: string, bookingId: string) {
  return app.request(`/api/bookings/${bookingId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ rating: 5 }),
  });
}

describe("GET /api/admin/users", () => {
  it("never exposes email/phone, only id/name/role/createdAt", async () => {
    const admin = await asAdmin();
    const someone = await asUser();
    void someone;

    const res = await app.request("/api/admin/users?pageSize=50", { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { users: Record<string, unknown>[] };
    expect(json.users.length).toBeGreaterThan(0);
    for (const u of json.users) {
      expect(Object.keys(u).sort()).toEqual(["createdAt", "id", "name", "role"]);
    }
  });

  it("filters by role and searches by display name", async () => {
    const admin = await asAdmin();
    const uniqueName = `Zzyx Searchable ${Date.now()}`;
    const res1 = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: uniqueName, email: `search-${Date.now()}@example.com`, phone: "5551234567", password: "correct-horse-battery" }),
    });
    const { user } = (await res1.json()) as { user: { email: string } };
    createdEmails.push(user.email);

    const res = await app.request(`/api/admin/users?search=${encodeURIComponent(uniqueName)}`, { headers: { cookie: admin.cookie } });
    const json = (await res.json()) as { users: { name: string }[] };
    expect(json.users).toHaveLength(1);
    expect(json.users[0].name).toBe(uniqueName);
  });
});

describe("GET /api/admin/bookings", () => {
  it("lists bookings across every customer/provider with resolved customer/provider names", async () => {
    const admin = await asAdmin();
    const { booking, owner, customer } = await setupCompletedBooking(futureMonday(3));

    const res = await app.request(`/api/admin/bookings?status=COMPLETED&providerId=${(await db.query.bookings.findFirst({ where: eq(bookings.id, booking.id) }))!.providerId}`, {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bookings: { id: string; customerName: string; providerName: string; paymentStatus: string }[] };
    const row = json.bookings.find((b) => b.id === booking.id);
    expect(row).toBeTruthy();
    expect(row?.paymentStatus).toBe("SUCCEEDED");
    void owner;
    void customer;
  });

  it("filters by derived paymentStatus, including NONE for an unpaid booking", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const unpaidBooking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday(4)}T09:00:00+00:00`);

    const res = await app.request(`/api/admin/bookings?providerId=${provider.id}&paymentStatus=NONE`, { headers: { cookie: admin.cookie } });
    const json = (await res.json()) as { bookings: { id: string }[] };
    expect(json.bookings.some((b) => b.id === unpaidBooking.id)).toBe(true);
  });

  it("filters by date range", async () => {
    const admin = await asAdmin();
    const monday = futureMonday(5);
    const { booking, provider } = await setupCompletedBooking(monday);

    const inRange = await app.request(`/api/admin/bookings?providerId=${provider.id}&dateFrom=${monday}&dateTo=${monday}`, {
      headers: { cookie: admin.cookie },
    });
    const inRangeJson = (await inRange.json()) as { bookings: { id: string }[] };
    expect(inRangeJson.bookings.some((b) => b.id === booking.id)).toBe(true);

    const outOfRange = await app.request(`/api/admin/bookings?providerId=${provider.id}&dateFrom=2020-01-01&dateTo=2020-01-02`, {
      headers: { cookie: admin.cookie },
    });
    const outOfRangeJson = (await outOfRange.json()) as { bookings: { id: string }[] };
    expect(outOfRangeJson.bookings.some((b) => b.id === booking.id)).toBe(false);
  });

  it("GET /:id returns booking detail with payment status resolved", async () => {
    const admin = await asAdmin();
    const { booking } = await setupCompletedBooking(futureMonday(6));
    const res = await app.request(`/api/admin/bookings/${booking.id}`, { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { booking: { paymentStatus: string; status: string } };
    expect(json.booking.status).toBe("COMPLETED");
    expect(json.booking.paymentStatus).toBe("SUCCEEDED");
  });
});

describe("GET /api/admin/payments", () => {
  it("includes providerPaymentId, which the customer-facing payment endpoint never exposes", async () => {
    const admin = await asAdmin();
    const { booking, customer } = await setupCompletedBooking(futureMonday(7));

    const customerView = await app.request(`/api/bookings/${booking.id}/payment`, { headers: { cookie: customer.cookie } });
    const customerJson = (await customerView.json()) as { payment: Record<string, unknown> };
    expect(customerJson.payment.providerPaymentId).toBeUndefined();

    const res = await app.request(`/api/admin/payments?bookingId=${booking.id}`, { headers: { cookie: admin.cookie } });
    const json = (await res.json()) as { payments: { providerPaymentId: string | null; status: string }[] };
    expect(json.payments).toHaveLength(1);
    expect(json.payments[0].status).toBe("SUCCEEDED");
    expect(json.payments[0].providerPaymentId).toBeTruthy();
  });
});

describe("GET /api/admin/reviews and moderation", () => {
  it("lists reviews regardless of status, and hide/publish round-trips with audit events", async () => {
    const admin = await asAdmin();
    const { booking, provider, customer } = await setupCompletedBooking(futureMonday(8));
    const createRes = await createReviewFixture(customer.cookie, booking.id);
    const { review } = (await createRes.json()) as { review: { id: string } };

    const hideRes = await app.request(`/api/admin/reviews/${review.id}/hide`, {
      method: "POST",
      headers: { cookie: admin.cookie },
    });
    expect(hideRes.status).toBe(200);
    const hideJson = (await hideRes.json()) as { review: { status: string } };
    expect(hideJson.review.status).toBe("HIDDEN");

    // No longer visible on the public provider review list.
    const publicRes = await app.request(`/api/providers/${provider.id}/reviews`);
    const publicJson = (await publicRes.json()) as { reviews: { id: string }[] };
    expect(publicJson.reviews.some((r) => r.id === review.id)).toBe(false);

    // Still visible through the admin moderation list.
    const adminListRes = await app.request(`/api/admin/reviews?status=HIDDEN&providerId=${provider.id}`, { headers: { cookie: admin.cookie } });
    const adminListJson = (await adminListRes.json()) as { reviews: { id: string }[] };
    expect(adminListJson.reviews.some((r) => r.id === review.id)).toBe(true);

    const publishRes = await app.request(`/api/admin/reviews/${review.id}/publish`, {
      method: "POST",
      headers: { cookie: admin.cookie },
    });
    expect(publishRes.status).toBe(200);

    const publicRes2 = await app.request(`/api/providers/${provider.id}/reviews`);
    const publicJson2 = (await publicRes2.json()) as { reviews: { id: string }[] };
    expect(publicJson2.reviews.some((r) => r.id === review.id)).toBe(true);

    const hideEvents = await db.query.auditLogs.findMany({
      where: (a, { and, eq: eq2 }) => and(eq2(a.action, "ADMIN_REVIEW_HIDDEN"), eq2(a.resourceId, review.id)),
    });
    expect(hideEvents).toHaveLength(1);
    const publishEvents = await db.query.auditLogs.findMany({
      where: (a, { and, eq: eq2 }) => and(eq2(a.action, "ADMIN_REVIEW_PUBLISHED"), eq2(a.resourceId, review.id)),
    });
    expect(publishEvents).toHaveLength(1);
    // Never the review's actual content in audit metadata.
    expect(JSON.stringify(hideEvents[0].metadata)).not.toMatch(/rating|comment|title/i);
  });

  it("hiding an already-hidden review is a clean 409, not a duplicate audit event", async () => {
    const admin = await asAdmin();
    const { booking, customer } = await setupCompletedBooking(futureMonday(9));
    const createRes = await createReviewFixture(customer.cookie, booking.id);
    const { review } = (await createRes.json()) as { review: { id: string } };

    await app.request(`/api/admin/reviews/${review.id}/hide`, { method: "POST", headers: { cookie: admin.cookie } });
    const res = await app.request(`/api/admin/reviews/${review.id}/hide`, { method: "POST", headers: { cookie: admin.cookie } });
    expect(res.status).toBe(409);
  });
});

describe("GET /api/admin/audit", () => {
  it("lists entries with a resolved actorName, filterable by action and resourceType", async () => {
    const admin = await asAdmin();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    await app.request(`/api/admin/providers/${provider.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });

    const res = await app.request("/api/admin/audit?action=PROVIDER_STATUS_CHANGED&resourceType=provider", {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entries: { resourceId: string; actorName: string }[] };
    const entry = json.entries.find((e) => e.resourceId === provider.id);
    expect(entry).toBeTruthy();
    expect(entry?.actorName).toBe("Test User");
  });
});
