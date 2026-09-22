import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, promoteToAdmin, registerAndLogin } from "./test-helpers.js";
import { bookings, payments, providers, users } from "./db/schema.js";
import { buildMockWebhookRequest, sign } from "./lib/payment-provider.js";
import type { PaymentWebhookEvent } from "./lib/payment-provider.js";

const { app, db, env } = createTestApp();

const createdEmails: string[] = [];

afterAll(async () => {
  if (createdEmails.length === 0) return;

  // Same FK-respecting cleanup order as bookings.test.ts: payments
  // reference bookings (RESTRICT), bookings reference providers/services/
  // pets (RESTRICT) — clear the leaf tables before deleting users.
  const testUsers = await db.query.users.findMany({ where: inArray(users.email, createdEmails) });
  const userIds = testUsers.map((u) => u.id);
  if (userIds.length > 0) {
    const ownedProviders = await db.query.providers.findMany({ where: inArray(providers.ownerUserId, userIds) });
    const providerIds = ownedProviders.map((p) => p.id);
    const ownedBookings = await db.query.bookings.findMany({
      where: providerIds.length > 0 ? inArray(bookings.providerId, providerIds) : inArray(bookings.customerUserId, userIds),
    });
    const customerBookings = await db.query.bookings.findMany({ where: inArray(bookings.customerUserId, userIds) });
    const bookingIds = [...new Set([...ownedBookings.map((b) => b.id), ...customerBookings.map((b) => b.id)])];
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

function futureMonday(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 2);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function createProvider(cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await app.request("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ businessName: "Payment Test Provider", providerType: "VET", timezone: "UTC", ...overrides }),
  });
  const { provider } = (await res.json()) as { provider: { id: string } };
  return provider;
}

async function createService(cookie: string, providerId: string, overrides: Record<string, unknown> = {}) {
  const res = await app.request(`/api/providers/${providerId}/services`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name: "Consultation", durationMinutes: 60, priceMinor: 79900, currency: "INR", ...overrides }),
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
    body: JSON.stringify({ name: "Fido", species: "Dog", ...overrides }),
  });
  const { pet } = (await res.json()) as { pet: { id: string } };
  return pet;
}

async function setupPayableBooking(monday = futureMonday()) {
  const owner = await asUser();
  const provider = await createProvider(owner.cookie);
  const service = await createService(owner.cookie, provider.id);
  await createRule(owner.cookie, provider.id);
  const customer = await asUser();
  const pet = await createPet(customer.cookie);

  const bookingRes = await app.request("/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: customer.cookie },
    body: JSON.stringify({ providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` }),
  });
  const { booking } = (await bookingRes.json()) as { booking: { id: string; priceMinor: number; currency: string; status: string } };
  return { owner, provider, service, customer, pet, booking, monday };
}

async function createPayment(cookie: string, bookingId: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return app.request(`/api/bookings/${bookingId}/payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, ...headers },
    body: JSON.stringify(body),
  });
}

async function getBookingPayment(cookie: string, bookingId: string) {
  return app.request(`/api/bookings/${bookingId}/payment`, { headers: { cookie } });
}

async function getBooking(cookie: string, bookingId: string) {
  return app.request(`/api/bookings/${bookingId}`, { headers: { cookie } });
}

async function sendWebhook(event: PaymentWebhookEvent, overrideSignature?: string, overrideBody?: string) {
  const { body, signature } = buildMockWebhookRequest(env.MOCK_PAYMENT_WEBHOOK_SECRET, event);
  return app.request("/api/payments/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mock-Signature": overrideSignature ?? signature },
    body: overrideBody ?? body,
  });
}

// -------------------------------------------------------------------------
// Creation
// -------------------------------------------------------------------------
describe("POST /api/bookings/:bookingId/payment — creation", () => {
  it("defaults to scenario=SUCCESS, creates a SUCCEEDED payment, and confirms the booking", async () => {
    const { customer, booking } = await setupPayableBooking();

    const res = await createPayment(customer.cookie, booking.id);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { payment: { status: string; amountMinor: number; currency: string; bookingId: string } };
    expect(json.payment.status).toBe("SUCCEEDED");
    expect(json.payment.amountMinor).toBe(booking.priceMinor);
    expect(json.payment.currency).toBe(booking.currency);
    expect(json.payment.bookingId).toBe(booking.id);

    const bookingRes = await getBooking(customer.cookie, booking.id);
    const bookingJson = (await bookingRes.json()) as { booking: { status: string } };
    expect(bookingJson.booking.status).toBe("CONFIRMED");
  });

  it("scenario=FAILURE creates a FAILED payment and cancels the booking", async () => {
    const { customer, booking } = await setupPayableBooking();

    const res = await createPayment(customer.cookie, booking.id, { scenario: "FAILURE" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { payment: { status: string; failureCode: string | null; failureMessage: string | null } };
    expect(json.payment.status).toBe("FAILED");
    expect(json.payment.failureCode).toBeTruthy();
    expect(json.payment.failureMessage).toBeTruthy();

    const bookingRes = await getBooking(customer.cookie, booking.id);
    const bookingJson = (await bookingRes.json()) as { booking: { status: string } };
    expect(bookingJson.booking.status).toBe("CANCELLED");
  });

  it("scenario=PENDING creates a PENDING payment and leaves the booking PENDING", async () => {
    const { customer, booking } = await setupPayableBooking();

    const res = await createPayment(customer.cookie, booking.id, { scenario: "PENDING" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { payment: { status: string } };
    expect(json.payment.status).toBe("PENDING");

    const bookingRes = await getBooking(customer.cookie, booking.id);
    const bookingJson = (await bookingRes.json()) as { booking: { status: string } };
    expect(bookingJson.booking.status).toBe("PENDING");
  });

  it("derives amount/currency from the booking, ignoring any client-supplied values", async () => {
    const { customer, booking } = await setupPayableBooking();

    const res = await createPayment(customer.cookie, booking.id, {
      amountMinor: 1,
      currency: "USD",
      customerUserId: "00000000-0000-0000-0000-000000000000",
      status: "SUCCEEDED",
      bookingPrice: 1,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { payment: { amountMinor: number; currency: string } };
    expect(json.payment.amountMinor).toBe(booking.priceMinor);
    expect(json.payment.currency).toBe(booking.currency);
  });

  it("never exposes providerPaymentId or other internal fields", async () => {
    const { customer, booking } = await setupPayableBooking();
    const res = await createPayment(customer.cookie, booking.id);
    const json = (await res.json()) as { payment: Record<string, unknown> };
    expect(json.payment).not.toHaveProperty("providerPaymentId");
  });

  it("ignores unknown/extra fields entirely, consistent with the repo's Zod policy", async () => {
    const { customer, booking } = await setupPayableBooking();
    const res = await createPayment(customer.cookie, booking.id, {
      isAdmin: true,
      __proto__: { polluted: true },
      providerPaymentId: "mock_success_fake",
      status: "SUCCEEDED",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { payment: Record<string, unknown> };
    expect(json.payment).not.toHaveProperty("isAdmin");
    expect(json.payment).not.toHaveProperty("polluted");
  });

  it("rejects an unauthenticated request", async () => {
    const { booking } = await setupPayableBooking();
    const res = await app.request(`/api/bookings/${booking.id}/payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a different customer paying for someone else's booking", async () => {
    const { booking } = await setupPayableBooking();
    const attacker = await asUser();
    const res = await createPayment(attacker.cookie, booking.id);
    expect(res.status).toBe(404);
  });

  it("rejects the provider owner initiating payment on the customer's behalf", async () => {
    const { owner, booking } = await setupPayableBooking();
    const res = await createPayment(owner.cookie, booking.id);
    expect(res.status).toBe(404);
  });

  it("rejects paying for an already-CONFIRMED booking (no double payment)", async () => {
    const { customer, booking } = await setupPayableBooking();
    const first = await createPayment(customer.cookie, booking.id);
    expect(first.status).toBe(201);

    const second = await createPayment(customer.cookie, booking.id);
    expect(second.status).toBe(409);
  });

  it("rejects paying for a CANCELLED booking", async () => {
    const { customer, booking } = await setupPayableBooking();
    await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: customer.cookie } });

    const res = await createPayment(customer.cookie, booking.id);
    expect(res.status).toBe(409);
  });

  it("returns 404 for a nonexistent booking", async () => {
    const customer = await asUser();
    const res = await createPayment(customer.cookie, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("rejects malformed JSON", async () => {
    const { customer, booking } = await setupPayableBooking();
    const res = await app.request(`/api/bookings/${booking.id}/payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("retrying while a PENDING payment is in flight returns the same payment, not a second one", async () => {
    const { customer, booking } = await setupPayableBooking();
    const first = await createPayment(customer.cookie, booking.id, { scenario: "PENDING" });
    const firstJson = (await first.json()) as { payment: { id: string } };

    const second = await createPayment(customer.cookie, booking.id, { scenario: "PENDING" });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { payment: { id: string } };
    expect(secondJson.payment.id).toBe(firstJson.payment.id);
  });
});

// -------------------------------------------------------------------------
// GET /api/bookings/:bookingId/payment and GET /api/payments/:id
// -------------------------------------------------------------------------
describe("GET payment — visibility", () => {
  it("the customer, the provider owner, and an admin can all view the payment; a stranger cannot", async () => {
    const { owner, customer, booking } = await setupPayableBooking();
    const created = await createPayment(customer.cookie, booking.id);
    const { payment } = (await created.json()) as { payment: { id: string } };

    const asCustomer = await app.request(`/api/payments/${payment.id}`, { headers: { cookie: customer.cookie } });
    expect(asCustomer.status).toBe(200);

    const asOwner = await app.request(`/api/payments/${payment.id}`, { headers: { cookie: owner.cookie } });
    expect(asOwner.status).toBe(200);

    const admin = await asAdmin();
    const asAdminRes = await app.request(`/api/payments/${payment.id}`, { headers: { cookie: admin.cookie } });
    expect(asAdminRes.status).toBe(200);

    const stranger = await asUser();
    const asStranger = await app.request(`/api/payments/${payment.id}`, { headers: { cookie: stranger.cookie } });
    expect(asStranger.status).toBe(404);
  });

  it("GET .../payment returns null before any payment attempt exists", async () => {
    const { customer, booking } = await setupPayableBooking();
    const res = await getBookingPayment(customer.cookie, booking.id);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { payment: unknown };
    expect(json.payment).toBeNull();
  });
});

// -------------------------------------------------------------------------
// Idempotency
// -------------------------------------------------------------------------
describe("POST /api/bookings/:bookingId/payment — idempotency", () => {
  it("same key + same booking replays the original payment", async () => {
    const { customer, booking } = await setupPayableBooking();
    const key = "pay-idem-same";

    const first = await createPayment(customer.cookie, booking.id, {}, { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { payment: { id: string } };

    const second = await createPayment(customer.cookie, booking.id, {}, { "Idempotency-Key": key });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { payment: { id: string } };
    expect(secondJson.payment.id).toBe(firstJson.payment.id);
  });

  it("same key + a different booking is a conflict", async () => {
    const { customer: customerA, booking: bookingA } = await setupPayableBooking();
    const monday = futureMonday();
    const providerB = await createProvider(customerA.cookie);
    const serviceB = await createService(customerA.cookie, providerB.id);
    await createRule(customerA.cookie, providerB.id);
    const petB = await createPet(customerA.cookie);
    const bookingBRes = await app.request("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: customerA.cookie },
      body: JSON.stringify({ providerId: providerB.id, serviceId: serviceB.id, petId: petB.id, startAt: `${monday}T11:00:00+00:00` }),
    });
    const { booking: bookingB } = (await bookingBRes.json()) as { booking: { id: string } };

    const key = "pay-idem-different-booking";
    const first = await createPayment(customerA.cookie, bookingA.id, {}, { "Idempotency-Key": key });
    expect(first.status).toBe(201);

    const second = await createPayment(customerA.cookie, bookingB.id, {}, { "Idempotency-Key": key });
    expect(second.status).toBe(409);
  });

  it("concurrent same-key requests converge on exactly one payment", async () => {
    const { customer, booking } = await setupPayableBooking();
    const key = "pay-idem-concurrent";

    const [a, b] = await Promise.all([
      createPayment(customer.cookie, booking.id, {}, { "Idempotency-Key": key }),
      createPayment(customer.cookie, booking.id, {}, { "Idempotency-Key": key }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 201]);
    const aJson = (await a.json()) as { payment: { id: string } };
    const bJson = (await b.json()) as { payment: { id: string } };
    expect(aJson.payment.id).toBe(bJson.payment.id);
  });
});

// -------------------------------------------------------------------------
// Concurrency — mandatory
// -------------------------------------------------------------------------
describe("concurrency — two concurrent payment-creation requests for the same booking", () => {
  it("exactly one payment operation succeeds; the booking is CONFIRMED exactly once", async () => {
    const { customer, booking } = await setupPayableBooking();

    const [a, b] = await Promise.all([createPayment(customer.cookie, booking.id), createPayment(customer.cookie, booking.id)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const [row] = await db.select().from(payments).where(eq(payments.bookingId, booking.id));
    expect(row.status).toBe("SUCCEEDED");
    const allForBooking = await db.select().from(payments).where(eq(payments.bookingId, booking.id));
    expect(allForBooking.filter((p) => p.status === "SUCCEEDED")).toHaveLength(1);

    const bookingRow = await db.query.bookings.findFirst({ where: eq(bookings.id, booking.id) });
    expect(bookingRow?.status).toBe("CONFIRMED");
  });
});

// -------------------------------------------------------------------------
// Webhook
// -------------------------------------------------------------------------
describe("POST /api/payments/webhook", () => {
  it("rejects a missing signature", async () => {
    const res = await app.request("/api/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "evt_1", type: "payment.succeeded", providerPaymentId: "mock_success_x", status: "SUCCEEDED" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a tampered/invalid signature", async () => {
    const res = await sendWebhook(
      { eventId: "evt_2", type: "payment.succeeded", providerPaymentId: "mock_success_x", status: "SUCCEEDED" },
      "0".repeat(64),
    );
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON even with a valid signature over that exact body", async () => {
    // Sign the ACTUAL garbage body being sent (not a well-formed one) —
    // otherwise this would just be testing the signature-mismatch path
    // again, not the JSON-parse path. This proves signature verification
    // and payload parsing are genuinely two separate checks.
    const garbage = "{not valid json";
    const signature = sign(env.MOCK_PAYMENT_WEBHOOK_SECRET, garbage);
    const res = await app.request("/api/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mock-Signature": signature },
      body: garbage,
    });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized webhook body", async () => {
    const res = await app.request("/api/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mock-Signature": "irrelevant" },
      body: "x".repeat(70 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it("rejects a webhook for an unknown provider payment id", async () => {
    const res = await sendWebhook({
      eventId: "evt_unknown",
      type: "payment.succeeded",
      providerPaymentId: "mock_success_does-not-exist",
      status: "SUCCEEDED",
    });
    expect(res.status).toBe(404);
  });

  it("resolves a PENDING payment to SUCCEEDED and confirms the booking", async () => {
    const { customer, booking } = await setupPayableBooking();
    const created = await createPayment(customer.cookie, booking.id, { scenario: "PENDING" });
    const { payment } = (await created.json()) as { payment: { id: string } };

    // The provider-side id is not exposed in the public DTO (by design —
    // see toPublicPayment) — reconstruct it exactly the way the mock
    // provider deterministically derives it, since that's the one thing
    // an external webhook delivery would actually carry.
    const providerPaymentId = `mock_pending_${payment.id}`;

    const webhookRes = await sendWebhook({
      eventId: `evt_resolve_${payment.id}`,
      type: "payment.succeeded",
      providerPaymentId,
      status: "SUCCEEDED",
    });
    expect(webhookRes.status).toBe(200);

    const bookingRes = await getBooking(customer.cookie, booking.id);
    const bookingJson = (await bookingRes.json()) as { booking: { status: string } };
    expect(bookingJson.booking.status).toBe("CONFIRMED");

    const paymentRow = await db.query.payments.findFirst({ where: eq(payments.id, payment.id) });
    expect(paymentRow?.status).toBe("SUCCEEDED");
  });

  it("duplicate delivery of the identical event is a safe no-op the second and third time", async () => {
    const { customer, booking } = await setupPayableBooking();
    const created = await createPayment(customer.cookie, booking.id, { scenario: "PENDING" });
    const { payment } = (await created.json()) as { payment: { id: string } };
    const providerPaymentId = `mock_pending_${payment.id}`;
    const event: PaymentWebhookEvent = {
      eventId: `evt_dup_${payment.id}`,
      type: "payment.succeeded",
      providerPaymentId,
      status: "SUCCEEDED",
    };

    const first = await sendWebhook(event);
    const second = await sendWebhook(event);
    const third = await sendWebhook(event);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    const firstJson = (await first.json()) as { applied: boolean; duplicate: boolean };
    const secondJson = (await second.json()) as { applied: boolean; duplicate: boolean };
    expect(firstJson.applied).toBe(true);
    expect(secondJson.duplicate).toBe(true);

    const paymentRow = await db.query.payments.findFirst({ where: eq(payments.id, payment.id) });
    expect(paymentRow?.status).toBe("SUCCEEDED");
  });

  it("10 concurrent deliveries of the identical event produce exactly one applied transition", async () => {
    const { booking, customer } = await setupPayableBooking();
    const created = await createPayment(customer.cookie, booking.id, { scenario: "PENDING" });
    const { payment } = (await created.json()) as { payment: { id: string } };
    const providerPaymentId = `mock_pending_${payment.id}`;
    const event: PaymentWebhookEvent = {
      eventId: `evt_stress_${payment.id}`,
      type: "payment.succeeded",
      providerPaymentId,
      status: "SUCCEEDED",
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => sendWebhook(event)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const bodies = (await Promise.all(results.map((r) => r.json()))) as Array<{ applied: boolean }>;
    expect(bodies.filter((b) => b.applied).length).toBe(1);

    const paymentRow = await db.query.payments.findFirst({ where: eq(payments.id, payment.id) });
    expect(paymentRow?.status).toBe("SUCCEEDED");
  });

  it("an out-of-order pending event arriving after succeeded does not regress the payment", async () => {
    const { customer, booking } = await setupPayableBooking();
    const created = await createPayment(customer.cookie, booking.id); // scenario defaults to SUCCESS, resolves immediately
    const { payment } = (await created.json()) as { payment: { id: string; status: string } };
    expect(payment.status).toBe("SUCCEEDED");
    const providerPaymentId = `mock_success_${payment.id}`;

    const res = await sendWebhook({
      eventId: `evt_out_of_order_${payment.id}`,
      type: "payment.pending",
      providerPaymentId,
      status: "PENDING",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { applied: boolean };
    expect(json.applied).toBe(false);

    const paymentRow = await db.query.payments.findFirst({ where: eq(payments.id, payment.id) });
    expect(paymentRow?.status).toBe("SUCCEEDED");
  });

  it("a success webhook arriving after the booking was independently cancelled leaves the booking cancelled", async () => {
    const { customer, booking } = await setupPayableBooking();
    const created = await createPayment(customer.cookie, booking.id, { scenario: "PENDING" });
    const { payment } = (await created.json()) as { payment: { id: string } };
    const providerPaymentId = `mock_pending_${payment.id}`;

    // The customer cancels the still-PENDING booking directly, independent of the in-flight payment.
    await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: customer.cookie } });

    const webhookRes = await sendWebhook({
      eventId: `evt_late_success_${payment.id}`,
      type: "payment.succeeded",
      providerPaymentId,
      status: "SUCCEEDED",
    });
    expect(webhookRes.status).toBe(200);

    // The payment itself genuinely succeeded (documented, intentional —
    // see routes/payments.ts's applyBookingSideEffect)...
    const paymentRow = await db.query.payments.findFirst({ where: eq(payments.id, payment.id) });
    expect(paymentRow?.status).toBe("SUCCEEDED");
    // ...but the booking is NOT forced back out of CANCELLED.
    const bookingRow = await db.query.bookings.findFirst({ where: eq(bookings.id, booking.id) });
    expect(bookingRow?.status).toBe("CANCELLED");
  });
});
