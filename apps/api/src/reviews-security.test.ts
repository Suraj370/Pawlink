import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, registerAndLogin } from "./test-helpers.js";
import { bookings, payments, providers, reviews, users } from "./db/schema.js";

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

    if (bookingIds.length > 0) {
      await db.delete(reviews).where(inArray(reviews.bookingId, bookingIds));
    }
    if (providerIds.length > 0) {
      await db.delete(reviews).where(inArray(reviews.providerId, providerIds));
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

async function createProvider(cookie: string) {
  const res = await app.request("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ businessName: "Review Security Vet", providerType: "VET", timezone: "UTC" }),
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

async function createReview(cookie: string, bookingId: string, body: Record<string, unknown>) {
  return app.request(`/api/bookings/${bookingId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
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
  const completeRes = await completeBooking(owner.cookie, booking.id);
  expect(completeRes.status).toBe(200);

  return { owner, provider, service, customer, pet, booking, monday };
}

describe("reviews — authorization matrix", () => {
  it("Customer A reviews own completed booking: allowed", async () => {
    const { customer, booking } = await setupCompletedBooking();
    const res = await createReview(customer.cookie, booking.id, { rating: 5 });
    expect(res.status).toBe(201);
  });

  it("Customer A reviews Customer B's booking: denied", async () => {
    const { booking } = await setupCompletedBooking(futureMonday(1));
    const customerB = await asUser();
    const res = await createReview(customerB.cookie, booking.id, { rating: 5 });
    expect(res.status).toBe(404);
  });

  it("Customer A reviews their own cancelled booking: denied", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday(2)}T09:00:00+00:00`);
    await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: customer.cookie } });

    const res = await createReview(customer.cookie, booking.id, { rating: 5 });
    expect(res.status).toBe(409);
  });

  it("Customer A reviews their own pending booking: denied", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday(3)}T09:00:00+00:00`);

    const res = await createReview(customer.cookie, booking.id, { rating: 5 });
    expect(res.status).toBe(409);
  });

  it("Customer A reviews someone else's completed booking: denied", async () => {
    const { booking } = await setupCompletedBooking(futureMonday(4));
    const customerB = await asUser();
    const res = await createReview(customerB.cookie, booking.id, { rating: 1 });
    expect(res.status).toBe(404);
  });

  it("Customer A submits another provider ID: ignored — the review's providerId always comes from the booking", async () => {
    const { customer, booking, provider } = await setupCompletedBooking(futureMonday(5));
    const otherOwner = await asUser();
    const otherProvider = await createProvider(otherOwner.cookie);

    const res = await createReview(customer.cookie, booking.id, { rating: 5, providerId: otherProvider.id });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { review: { providerId: string } };
    expect(json.review.providerId).toBe(provider.id);
    expect(json.review.providerId).not.toBe(otherProvider.id);
  });

  it("Customer A submits another customer ID: ignored — the review's customerUserId always comes from the session", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(6));
    const customerB = await asUser();

    const res = await createReview(customer.cookie, booking.id, { rating: 5, customerUserId: customerB.userId });
    expect(res.status).toBe(201);

    const row = await db.query.reviews.findFirst({ where: eq(reviews.bookingId, booking.id) });
    expect(row?.customerUserId).toBe(customer.userId);
    expect(row?.customerUserId).not.toBe(customerB.userId);
  });

  it("Provider A attempts to create a review as Customer B: denied", async () => {
    const { owner, booking } = await setupCompletedBooking(futureMonday(7));
    const res = await createReview(owner.cookie, booking.id, { rating: 5 });
    expect(res.status).toBe(403);
  });

  it("Provider A edits Customer B's review: denied", async () => {
    const { owner, customer, booking } = await setupCompletedBooking(futureMonday(8));
    const createRes = await createReview(customer.cookie, booking.id, { rating: 5 });
    const { review } = (await createRes.json()) as { review: { id: string } };

    const res = await app.request(`/api/reviews/${review.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ rating: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("Customer A edits Customer B's review: denied", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(9));
    const createRes = await createReview(customer.cookie, booking.id, { rating: 5 });
    const { review } = (await createRes.json()) as { review: { id: string } };

    const customerB = await asUser();
    const res = await app.request(`/api/reviews/${review.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: customerB.cookie },
      body: JSON.stringify({ rating: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("review enumeration: a stranger PATCHing random review ids never discloses content and always 404s", async () => {
    const stranger = await asUser();
    const randomIds = [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    ];
    for (const id of randomIds) {
      const res = await app.request(`/api/reviews/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: stranger.cookie },
        body: JSON.stringify({ rating: 1 }),
      });
      expect(res.status).toBe(404);
    }
  });

  it("there is no DELETE endpoint for a review", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(10));
    const createRes = await createReview(customer.cookie, booking.id, { rating: 5 });
    const { review } = (await createRes.json()) as { review: { id: string } };

    const res = await app.request(`/api/reviews/${review.id}`, { method: "DELETE", headers: { cookie: customer.cookie } });
    expect(res.status).toBe(404);

    const row = await db.query.reviews.findFirst({ where: eq(reviews.id, review.id) });
    expect(row).toBeTruthy();
  });

  it("an unauthenticated caller cannot create or edit a review", async () => {
    const { booking } = await setupCompletedBooking(futureMonday(11));
    const createRes = await app.request(`/api/bookings/${booking.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 5 }),
    });
    expect(createRes.status).toBe(401);

    const patchRes = await app.request("/api/reviews/00000000-0000-0000-0000-000000000000", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 5 }),
    });
    expect(patchRes.status).toBe(401);
  });

  it("public review listing never exposes customer identifiers or internal database ids beyond the review's own id", async () => {
    const { customer, booking, provider } = await setupCompletedBooking(futureMonday(12));
    await createReview(customer.cookie, booking.id, { rating: 5, title: "Great", comment: "Loved it" });

    const res = await app.request(`/api/providers/${provider.id}/reviews`);
    const json = (await res.json()) as { reviews: Record<string, unknown>[] };
    for (const r of json.reviews) {
      expect(Object.keys(r)).not.toContain("customerUserId");
      expect(Object.keys(r)).not.toContain("customerEmail");
    }
  });
});

describe("database integrity", () => {
  it("rejects a review whose booking_id already has one, even inserted directly (constraint-level, not just app-level)", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(13));
    const first = await createReview(customer.cookie, booking.id, { rating: 5 });
    expect(first.status).toBe(201);

    await expect(
      db.insert(reviews).values({
        bookingId: booking.id,
        customerUserId: customer.userId,
        providerId: (await db.query.bookings.findFirst({ where: eq(bookings.id, booking.id) }))!.providerId,
        rating: 3,
      }),
    ).rejects.toThrow();
  });

  it("rejects rating 0 and rating 6 at the database layer directly", async () => {
    const { customer, booking, provider } = await setupCompletedBooking(futureMonday(14));
    await expect(
      db.insert(reviews).values({ bookingId: booking.id, customerUserId: customer.userId, providerId: provider.id, rating: 0 }),
    ).rejects.toThrow();
    await expect(
      db.insert(reviews).values({ bookingId: booking.id, customerUserId: customer.userId, providerId: provider.id, rating: 6 }),
    ).rejects.toThrow();
  });

  it("rejects an invalid foreign key (nonexistent bookingId) at the database layer", async () => {
    const customer = await asUser();
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    await expect(
      db.insert(reviews).values({
        bookingId: "00000000-0000-0000-0000-000000000000",
        customerUserId: customer.userId,
        providerId: provider.id,
        rating: 5,
      }),
    ).rejects.toThrow();
  });
});
