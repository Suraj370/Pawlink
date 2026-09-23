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

async function createProvider(cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await app.request("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ businessName: "Reviews Test Vet", providerType: "VET", timezone: "UTC", ...overrides }),
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

// -------------------------------------------------------------------------
// Booking completion — necessary prerequisite plumbing for review
// eligibility (see docs/architecture.md, "Reviews & ratings").
// -------------------------------------------------------------------------
describe("POST /api/bookings/:id/complete", () => {
  it("lets the provider owner mark a CONFIRMED booking COMPLETED", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday()}T09:00:00+00:00`);
    await payBooking(customer.cookie, booking.id);

    const res = await completeBooking(owner.cookie, booking.id);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { booking: { status: string } };
    expect(json.booking.status).toBe("COMPLETED");
  });

  it("rejects the customer marking their own booking complete", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday()}T09:00:00+00:00`);
    await payBooking(customer.cookie, booking.id);

    const res = await completeBooking(customer.cookie, booking.id);
    expect(res.status).toBe(403);
  });

  it("rejects an unrelated provider marking someone else's booking complete", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const freshBooking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday(2)}T09:00:00+00:00`);
    await payBooking(customer.cookie, freshBooking.id);

    const stranger = await asUser();
    const res = await completeBooking(stranger.cookie, freshBooking.id);
    expect(res.status).toBe(404);
  });

  it("cannot complete a PENDING booking, and cannot complete twice", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday()}T09:00:00+00:00`);

    const pendingRes = await completeBooking(owner.cookie, booking.id);
    expect(pendingRes.status).toBe(409);

    await payBooking(customer.cookie, booking.id);
    const firstComplete = await completeBooking(owner.cookie, booking.id);
    expect(firstComplete.status).toBe(200);
    const secondComplete = await completeBooking(owner.cookie, booking.id);
    expect(secondComplete.status).toBe(409);
  });
});

// -------------------------------------------------------------------------
// Review creation
// -------------------------------------------------------------------------
describe("POST /api/bookings/:bookingId/review", () => {
  it("lets the customer review their own completed booking", async () => {
    const { customer, booking, provider } = await setupCompletedBooking();
    const res = await createReview(customer.cookie, booking.id, { rating: 5, title: "Great!", comment: "Very professional." });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { review: Record<string, unknown> };
    expect(json.review.bookingId).toBe(booking.id);
    expect(json.review.providerId).toBe(provider.id);
    expect(json.review.rating).toBe(5);
    expect(json.review.status).toBe("PUBLISHED");
  });

  it("trims whitespace and treats whitespace-only title/comment as absent", async () => {
    const { customer, booking } = await setupCompletedBooking();
    const res = await createReview(customer.cookie, booking.id, { rating: 4, title: "   ", comment: "  \n  " });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { review: { title: string | null; comment: string | null } };
    expect(json.review.title).toBeNull();
    expect(json.review.comment).toBeNull();
  });

  it("rejects rating 0", async () => {
    const { customer, booking } = await setupCompletedBooking();
    const res = await createReview(customer.cookie, booking.id, { rating: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects rating 6", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(1));
    const res = await createReview(customer.cookie, booking.id, { rating: 6 });
    expect(res.status).toBe(400);
  });

  it("rejects a negative rating", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(2));
    const res = await createReview(customer.cookie, booking.id, { rating: -1 });
    expect(res.status).toBe(400);
  });

  it("rejects a fractional rating", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(3));
    const res = await createReview(customer.cookie, booking.id, { rating: 3.5 });
    expect(res.status).toBe(400);
  });

  it("rejects an absurdly large rating", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(4));
    const res = await createReview(customer.cookie, booking.id, { rating: 999999 });
    expect(res.status).toBe(400);
  });

  it("rejects a title over 150 characters", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(5));
    const res = await createReview(customer.cookie, booking.id, { rating: 5, title: "x".repeat(200) });
    expect(res.status).toBe(400);
  });

  it("rejects a comment over 2000 characters", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(6));
    const res = await createReview(customer.cookie, booking.id, { rating: 5, comment: "x".repeat(3000) });
    expect(res.status).toBe(400);
  });

  it("rejects a PENDING booking", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday()}T09:00:00+00:00`);

    const res = await createReview(customer.cookie, booking.id, { rating: 5 });
    expect(res.status).toBe(409);
  });

  it("rejects a CONFIRMED (not yet completed) booking", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday()}T09:00:00+00:00`);
    await payBooking(customer.cookie, booking.id);

    const res = await createReview(customer.cookie, booking.id, { rating: 5 });
    expect(res.status).toBe(409);
  });

  it("rejects a CANCELLED booking", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday()}T09:00:00+00:00`);
    await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: customer.cookie } });

    const res = await createReview(customer.cookie, booking.id, { rating: 5 });
    expect(res.status).toBe(409);
  });

  it("rejects a duplicate review for the same booking", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(7));
    const first = await createReview(customer.cookie, booking.id, { rating: 5 });
    expect(first.status).toBe(201);
    const second = await createReview(customer.cookie, booking.id, { rating: 1 });
    expect(second.status).toBe(409);

    const rows = await db.query.reviews.findMany({ where: eq(reviews.bookingId, booking.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(5);
  });

  it("mass assignment: ignores a client-supplied bookingId/customerUserId/providerId/status/createdAt", async () => {
    const { customer, booking, provider } = await setupCompletedBooking(futureMonday(8));
    const otherBooking = await setupCompletedBooking(futureMonday(9));
    const res = await createReview(customer.cookie, booking.id, {
      rating: 5,
      bookingId: otherBooking.booking.id,
      customerUserId: "11111111-1111-1111-1111-111111111111",
      providerId: "22222222-2222-2222-2222-222222222222",
      status: "HIDDEN",
      createdAt: "2020-01-01T00:00:00Z",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { review: Record<string, unknown> };
    expect(json.review.bookingId).toBe(booking.id);
    expect(json.review.providerId).toBe(provider.id);
    expect(json.review.status).toBe("PUBLISHED");
  });

  it("rejects a malformed booking id", async () => {
    const { customer } = await setupCompletedBooking(futureMonday(10));
    const res = await createReview(customer.cookie, "not-a-uuid", { rating: 5 });
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request", async () => {
    const { booking } = await setupCompletedBooking(futureMonday(11));
    const res = await app.request(`/api/bookings/${booking.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 5 }),
    });
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------
// Concurrency — the mandatory duplicate-review race test.
// -------------------------------------------------------------------------
describe("concurrent review creation", () => {
  it("exactly one of two concurrent review submissions for the same booking succeeds; the other gets a clean 409", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(12));

    const [resA, resB] = await Promise.all([
      createReview(customer.cookie, booking.id, { rating: 5, title: "A" }),
      createReview(customer.cookie, booking.id, { rating: 1, title: "B" }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const rows = await db.query.reviews.findMany({ where: eq(reviews.bookingId, booking.id) });
    expect(rows).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------
// Review editing
// -------------------------------------------------------------------------
describe("PATCH /api/reviews/:id", () => {
  it("lets the reviewing customer edit rating/title/comment", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(13));
    const createRes = await createReview(customer.cookie, booking.id, { rating: 3, title: "Okay" });
    const { review } = (await createRes.json()) as { review: { id: string } };

    const res = await app.request(`/api/reviews/${review.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: JSON.stringify({ rating: 5, title: "Actually great" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { review: { rating: number; title: string } };
    expect(json.review.rating).toBe(5);
    expect(json.review.title).toBe("Actually great");
  });

  it("never allows bookingId/customerUserId/providerId/createdAt to be changed via PATCH", async () => {
    const { customer, booking, provider } = await setupCompletedBooking(futureMonday(14));
    const createRes = await createReview(customer.cookie, booking.id, { rating: 3 });
    const { review: created } = (await createRes.json()) as { review: Record<string, unknown> };

    const res = await app.request(`/api/reviews/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: JSON.stringify({
        bookingId: "11111111-1111-1111-1111-111111111111",
        customerUserId: "22222222-2222-2222-2222-222222222222",
        providerId: "33333333-3333-3333-3333-333333333333",
        createdAt: "2020-01-01T00:00:00Z",
        rating: 4,
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { review: Record<string, unknown> };
    expect(json.review.bookingId).toBe(booking.id);
    expect(json.review.providerId).toBe(provider.id);
    expect(json.review.createdAt).toBe(created.createdAt);
  });

  it("returns 400 for an empty patch body", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(15));
    const createRes = await createReview(customer.cookie, booking.id, { rating: 3 });
    const { review } = (await createRes.json()) as { review: { id: string } };

    const res = await app.request(`/api/reviews/${review.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range rating on edit", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(16));
    const createRes = await createReview(customer.cookie, booking.id, { rating: 3 });
    const { review } = (await createRes.json()) as { review: { id: string } };

    const res = await app.request(`/api/reviews/${review.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: JSON.stringify({ rating: 0 }),
    });
    expect(res.status).toBe(400);
  });
});

// -------------------------------------------------------------------------
// Public provider review listing and aggregate rating.
// -------------------------------------------------------------------------
describe("GET /api/providers/:providerId/reviews", () => {
  it("lists PUBLISHED reviews and computes the correct aggregate", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);

    const ratings = [5, 5, 4];
    for (let i = 0; i < ratings.length; i++) {
      const customer = await asUser();
      const pet = await createPet(customer.cookie);
      const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday(i)}T09:00:00+00:00`);
      await payBooking(customer.cookie, booking.id);
      await completeBooking(owner.cookie, booking.id);
      const res = await createReview(customer.cookie, booking.id, { rating: ratings[i] });
      expect(res.status).toBe(201);
    }

    const res = await app.request(`/api/providers/${provider.id}/reviews`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      reviews: { rating: number; reviewerDisplayName: string }[];
      total: number;
      aggregate: { averageRating: number; reviewCount: number };
    };
    expect(json.reviews).toHaveLength(3);
    expect(json.total).toBe(3);
    expect(json.aggregate.reviewCount).toBe(3);
    expect(json.aggregate.averageRating).toBeCloseTo(4.67, 2);
    // No email/customerUserId ever exposed in the public shape.
    expect(JSON.stringify(json.reviews)).not.toMatch(/@/);
  });

  it("a provider with zero reviews has a null average, not zero", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);

    const res = await app.request(`/api/providers/${provider.id}/reviews`);
    const json = (await res.json()) as { aggregate: { averageRating: number | null; reviewCount: number } };
    expect(json.aggregate.averageRating).toBeNull();
    expect(json.aggregate.reviewCount).toBe(0);
  });

  it("the provider detail and list endpoints expose the same aggregate", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id);
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const booking = await createBooking(customer.cookie, provider.id, service.id, pet.id, `${futureMonday()}T09:00:00+00:00`);
    await payBooking(customer.cookie, booking.id);
    await completeBooking(owner.cookie, booking.id);
    await createReview(customer.cookie, booking.id, { rating: 4 });

    const detailRes = await app.request(`/api/providers/${provider.id}`);
    const detailJson = (await detailRes.json()) as { provider: { averageRating: number; reviewCount: number } };
    expect(detailJson.provider.averageRating).toBe(4);
    expect(detailJson.provider.reviewCount).toBe(1);
  });

  it("rejects an invalid provider id", async () => {
    const res = await app.request("/api/providers/not-a-uuid/reviews");
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent provider", async () => {
    const res = await app.request("/api/providers/00000000-0000-0000-0000-000000000000/reviews");
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------------------
// XSS / injection safety — review text is stored and returned as plain
// text; nothing in this codebase ever renders it as raw HTML (see
// apps/web/src/features/reviews for the React components, which render
// review text through ordinary JSX text nodes — escaped by React by
// construction).
// -------------------------------------------------------------------------
describe("adversarial review", () => {
  it("stores a script-tag payload as inert text, not executable markup", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(17));
    const payload = "<script>alert(1)</script>";
    const res = await createReview(customer.cookie, booking.id, { rating: 5, comment: payload });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { review: { comment: string } };
    expect(json.review.comment).toBe(payload);
  });

  it("rejects a request body that is an array instead of an object", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(18));
    const res = await app.request(`/api/bookings/${booking.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const { customer, booking } = await setupCompletedBooking(futureMonday(19));
    const res = await app.request(`/api/bookings/${booking.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
