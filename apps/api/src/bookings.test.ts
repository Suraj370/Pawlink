import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, promoteToAdmin, registerAndLogin } from "./test-helpers.js";
import { bookings, providers, users } from "./db/schema.js";

const { app, db } = createTestApp();

const createdEmails: string[] = [];

afterAll(async () => {
  if (createdEmails.length === 0) return;

  // bookings.provider_id/service_id/pet_id are RESTRICT (never CASCADE —
  // see db/schema.ts), so cascading a test user's deletion into their
  // owned providers/pets fails while any booking still references them.
  // Bookings must be cleared explicitly first, covering both directions:
  // bookings this user made as a customer, and bookings made by OTHER
  // test users against a provider this user owns.
  const testUsers = await db.query.users.findMany({ where: inArray(users.email, createdEmails) });
  const userIds = testUsers.map((u) => u.id);
  if (userIds.length > 0) {
    const ownedProviders = await db.query.providers.findMany({ where: inArray(providers.ownerUserId, userIds) });
    const providerIds = ownedProviders.map((p) => p.id);
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
    body: JSON.stringify({ businessName: "Booking Test Provider", providerType: "VET", timezone: "UTC", ...overrides }),
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

async function setupBookableProvider(monday = futureMonday()) {
  const owner = await asUser();
  const provider = await createProvider(owner.cookie);
  const service = await createService(owner.cookie, provider.id);
  await createRule(owner.cookie, provider.id);
  return { owner, provider, service, monday };
}

async function createBooking(
  cookie: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.request("/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/bookings — creation", () => {
  it("lets an authenticated customer book an available slot", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);

    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: `${monday}T09:00:00+00:00`,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { booking: Record<string, unknown> };
    expect(json.booking.status).toBe("CONFIRMED");
    expect(json.booking.startAt).toBe(new Date(`${monday}T09:00:00+00:00`).toISOString());
    expect(json.booking.endAt).toBe(new Date(`${monday}T10:00:00+00:00`).toISOString());
    expect(json.booking.priceMinor).toBe(79900);
    expect(json.booking.currency).toBe("INR");
    expect(json.booking.serviceName).toBe("Consultation");
    expect(json.booking.serviceDurationMinutes).toBe(60);
  });

  it("rejects an unauthenticated request", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const res = await app.request("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: provider.id, serviceId: service.id, petId: "00000000-0000-0000-0000-000000000000", startAt: `${monday}T09:00:00+00:00` }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON", async () => {
    const customer = await asUser();
    const res = await app.request("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: customer.cookie },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a startAt with no timezone offset", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: `${monday}T09:00:00`,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed providerId/serviceId/petId", async () => {
    const customer = await asUser();
    const res = await createBooking(customer.cookie, {
      providerId: "not-a-uuid",
      serviceId: "not-a-uuid",
      petId: "not-a-uuid",
      startAt: "2031-01-06T09:00:00+00:00",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent provider", async () => {
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const res = await createBooking(customer.cookie, {
      providerId: "00000000-0000-0000-0000-000000000000",
      serviceId: "00000000-0000-0000-0000-000000000000",
      petId: pet.id,
      startAt: "2031-01-06T09:00:00+00:00",
    });
    expect(res.status).toBe(404);
  });

  it("rejects booking an arbitrary time not aligned to the schedule", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: `${monday}T03:17:00+00:00`,
    });
    expect(res.status).toBe(409);
  });

  it("rejects a time outside the configured window", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: `${monday}T18:00:00+00:00`,
    });
    expect(res.status).toBe(409);
  });

  it("rejects a service duration that no longer fits the window", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id, { durationMinutes: 600 });
    await createRule(owner.cookie, provider.id, { startTime: "09:00", endTime: "10:00" });
    const monday = futureMonday();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: `${monday}T09:00:00+00:00`,
    });
    expect(res.status).toBe(409);
  });

  it("rejects a past slot", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const service = await createService(owner.cookie, provider.id);
    await createRule(owner.cookie, provider.id, { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" });
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: "2020-01-06T09:00:00+00:00",
    });
    expect(res.status).toBe(409);
  });

  it("respects a CLOSED date exception", async () => {
    const { owner, provider, service, monday } = await setupBookableProvider();
    await app.request(`/api/providers/${provider.id}/availability/exceptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ date: monday, type: "CLOSED" }),
    });
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: `${monday}T09:00:00+00:00`,
    });
    expect(res.status).toBe(409);
  });

  it("rejects booking against an inactive provider", async () => {
    const { owner, provider, service, monday } = await setupBookableProvider();
    await app.request(`/api/providers/${provider.id}`, { method: "DELETE", headers: { cookie: owner.cookie } });
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: `${monday}T09:00:00+00:00`,
    });
    expect(res.status).toBe(409);
  });

  it("rejects booking an inactive service", async () => {
    const { owner, provider, service, monday } = await setupBookableProvider();
    await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: `${monday}T09:00:00+00:00`,
    });
    expect(res.status).toBe(409);
  });

  it("rejects a service that belongs to a different provider", async () => {
    const { provider, monday } = await setupBookableProvider();
    const otherOwner = await asUser();
    const otherProvider = await createProvider(otherOwner.cookie);
    const otherService = await createService(otherOwner.cookie, otherProvider.id);

    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: otherService.id,
      petId: pet.id,
      startAt: `${monday}T09:00:00+00:00`,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/bookings — pet authorization", () => {
  it("rejects booking with another user's pet", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const victim = await asUser();
    const victimPet = await createPet(victim.cookie);
    const attacker = await asUser();

    const res = await createBooking(attacker.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: victimPet.id,
      startAt: `${monday}T09:00:00+00:00`,
    });
    expect(res.status).toBe(404);
  });

  it("rejects a nonexistent pet", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: "00000000-0000-0000-0000-000000000000",
      startAt: `${monday}T09:00:00+00:00`,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/bookings — mass assignment ignored", () => {
  it("ignores a client-supplied customerUserId, price, duration, endAt, and status", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const victim = await asUser();
    const pet = await createPet(customer.cookie);

    const res = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: `${monday}T09:00:00+00:00`,
      customerUserId: victim.userId,
      priceMinor: 1,
      currency: "USD",
      endAt: `${monday}T09:01:00+00:00`,
      serviceDurationMinutesSnapshot: 1,
      status: "CONFIRMED",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      booking: { id: string; priceMinor: number; currency: string; endAt: string; serviceDurationMinutes: number };
    };
    // Server-derived values, not the injected ones.
    expect(json.booking.priceMinor).toBe(79900);
    expect(json.booking.currency).toBe("INR");
    expect(json.booking.serviceDurationMinutes).toBe(60);
    expect(json.booking.endAt).toBe(new Date(`${monday}T10:00:00+00:00`).toISOString());

    // Confirm the booking is attributed to the actual authenticated
    // customer, not the injected victim id — it shows up in the real
    // customer's own list and not the victim's.
    const customerList = await app.request("/api/bookings", { headers: { cookie: customer.cookie } });
    const customerJson = (await customerList.json()) as { bookings: Array<{ id: string }> };
    expect(customerJson.bookings.some((b) => b.id === json.booking.id)).toBe(true);

    const victimList = await app.request("/api/bookings", { headers: { cookie: victim.cookie } });
    const victimJson = (await victimList.json()) as { bookings: Array<{ id: string }> };
    expect(victimJson.bookings.some((b) => b.id === json.booking.id)).toBe(false);
  });
});

describe("historical snapshots survive later service changes", () => {
  it("keeps the original price/name/duration after the service is edited", async () => {
    const { owner, provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);

    const bookingRes = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: `${monday}T09:00:00+00:00`,
    });
    const { booking } = (await bookingRes.json()) as { booking: { id: string } };

    await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ name: "Renamed Service", priceMinor: 1, durationMinutes: 5 }),
    });

    const res = await app.request(`/api/bookings/${booking.id}`, { headers: { cookie: customer.cookie } });
    const json = (await res.json()) as {
      booking: { serviceName: string; priceMinor: number; serviceDurationMinutes: number };
    };
    expect(json.booking.serviceName).toBe("Consultation");
    expect(json.booking.priceMinor).toBe(79900);
    expect(json.booking.serviceDurationMinutes).toBe(60);
  });

  it("keeps an existing booking valid after the service is deactivated", async () => {
    const { owner, provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);

    const bookingRes = await createBooking(customer.cookie, {
      providerId: provider.id,
      serviceId: service.id,
      petId: pet.id,
      startAt: `${monday}T09:00:00+00:00`,
    });
    const { booking } = (await bookingRes.json()) as { booking: { id: string } };

    await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });

    const res = await app.request(`/api/bookings/${booking.id}`, { headers: { cookie: customer.cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { booking: { status: string } };
    expect(json.booking.status).toBe("CONFIRMED");
  });

  it("prevents deleting a pet that has booking history, with a clean error (not a raw DB error)", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });

    const res = await app.request(`/api/pets/${pet.id}`, { method: "DELETE", headers: { cookie: customer.cookie } });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error.toLowerCase()).not.toContain("constraint");
    expect(json.error.toLowerCase()).not.toContain("postgres");

    // The pet is still there and the booking is unaffected.
    const petRes = await app.request(`/api/pets/${pet.id}`, { headers: { cookie: customer.cookie } });
    expect(petRes.status).toBe(200);
  });
});

describe("GET /api/bookings — listing and visibility", () => {
  it("returns only the caller's own bookings by default", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customerA = await asUser();
    const petA = await createPet(customerA.cookie);
    await createBooking(customerA.cookie, { providerId: provider.id, serviceId: service.id, petId: petA.id, startAt: `${monday}T09:00:00+00:00` });

    const customerB = await asUser();
    const res = await app.request("/api/bookings", { headers: { cookie: customerB.cookie } });
    const json = (await res.json()) as { bookings: unknown[] };
    expect(json.bookings).toHaveLength(0);
  });

  it("lets a provider owner list bookings for their own provider", async () => {
    const { owner, provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });

    const res = await app.request(`/api/bookings?providerId=${provider.id}`, { headers: { cookie: owner.cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bookings: unknown[] };
    expect(json.bookings).toHaveLength(1);
  });

  it("prevents a different provider owner from listing another provider's bookings", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });

    const otherOwner = await asUser();
    const res = await app.request(`/api/bookings?providerId=${provider.id}`, { headers: { cookie: otherOwner.cookie } });
    expect(res.status).toBe(404);
  });

  it("lets an admin list bookings for a provider they don't own", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });

    const admin = await asAdmin();
    const res = await app.request(`/api/bookings?providerId=${provider.id}`, { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bookings: unknown[] };
    expect(json.bookings).toHaveLength(1);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/bookings");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/bookings/:id — read authorization", () => {
  it("lets the customer read their own booking", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const created = await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });
    const { booking } = (await created.json()) as { booking: { id: string } };

    const res = await app.request(`/api/bookings/${booking.id}`, { headers: { cookie: customer.cookie } });
    expect(res.status).toBe(200);
  });

  it("lets the provider owner read a booking for their provider", async () => {
    const { owner, provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const created = await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });
    const { booking } = (await created.json()) as { booking: { id: string } };

    const res = await app.request(`/api/bookings/${booking.id}`, { headers: { cookie: owner.cookie } });
    expect(res.status).toBe(200);
  });

  it("prevents a different customer from reading the booking", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const created = await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });
    const { booking } = (await created.json()) as { booking: { id: string } };

    const otherCustomer = await asUser();
    const res = await app.request(`/api/bookings/${booking.id}`, { headers: { cookie: otherCustomer.cookie } });
    expect(res.status).toBe(404);
  });

  it("prevents a different provider owner from reading the booking", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const created = await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });
    const { booking } = (await created.json()) as { booking: { id: string } };

    const otherOwner = await asUser();
    const res = await app.request(`/api/bookings/${booking.id}`, { headers: { cookie: otherOwner.cookie } });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed booking id", async () => {
    const customer = await asUser();
    const res = await app.request("/api/bookings/not-a-uuid", { headers: { cookie: customer.cookie } });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/bookings/:id/cancel", () => {
  it("lets the customer cancel their own booking", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const created = await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });
    const { booking } = (await created.json()) as { booking: { id: string } };

    const res = await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: customer.cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { booking: { status: string } };
    expect(json.booking.status).toBe("CANCELLED");
  });

  it("lets the provider owner cancel a booking for their provider", async () => {
    const { owner, provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const created = await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });
    const { booking } = (await created.json()) as { booking: { id: string } };

    const res = await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: owner.cookie } });
    expect(res.status).toBe(200);
  });

  it("prevents a different customer from cancelling the booking", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const created = await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });
    const { booking } = (await created.json()) as { booking: { id: string } };

    const attacker = await asUser();
    const res = await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: attacker.cookie } });
    expect(res.status).toBe(404);

    const verify = await app.request(`/api/bookings/${booking.id}`, { headers: { cookie: customer.cookie } });
    const verifyJson = (await verify.json()) as { booking: { status: string } };
    expect(verifyJson.booking.status).toBe("CONFIRMED");
  });

  it("prevents a different provider owner from cancelling the booking", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const created = await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });
    const { booking } = (await created.json()) as { booking: { id: string } };

    const otherOwner = await asUser();
    const res = await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: otherOwner.cookie } });
    expect(res.status).toBe(404);
  });

  it("rejects cancelling an already-cancelled booking", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const created = await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` });
    const { booking } = (await created.json()) as { booking: { id: string } };

    await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: customer.cookie } });
    const res = await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: customer.cookie } });
    expect(res.status).toBe(409);
  });

  it("frees the slot for a new booking once cancelled", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customerA = await asUser();
    const petA = await createPet(customerA.cookie);
    const created = await createBooking(customerA.cookie, { providerId: provider.id, serviceId: service.id, petId: petA.id, startAt: `${monday}T09:00:00+00:00` });
    const { booking } = (await created.json()) as { booking: { id: string } };

    await app.request(`/api/bookings/${booking.id}/cancel`, { method: "POST", headers: { cookie: customerA.cookie } });

    const customerB = await asUser();
    const petB = await createPet(customerB.cookie);
    const res = await createBooking(customerB.cookie, { providerId: provider.id, serviceId: service.id, petId: petB.id, startAt: `${monday}T09:00:00+00:00` });
    expect(res.status).toBe(201);
  });
});

describe("idempotency", () => {
  it("replaying the same key and same request returns the same booking, not a new one", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const body = { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` };
    const key = "idem-key-same-request";

    const first = await createBooking(customer.cookie, body, { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { booking: { id: string } };

    const second = await createBooking(customer.cookie, body, { "Idempotency-Key": key });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { booking: { id: string } };
    expect(secondJson.booking.id).toBe(firstJson.booking.id);

    const list = await app.request("/api/bookings", { headers: { cookie: customer.cookie } });
    const listJson = (await list.json()) as { bookings: unknown[] };
    expect(listJson.bookings).toHaveLength(1);
  });

  it("reusing the same key with different parameters is a conflict", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const key = "idem-key-different-request";

    const first = await createBooking(
      customer.cookie,
      { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T09:00:00+00:00` },
      { "Idempotency-Key": key },
    );
    expect(first.status).toBe(201);

    const second = await createBooking(
      customer.cookie,
      { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T10:00:00+00:00` },
      { "Idempotency-Key": key },
    );
    expect(second.status).toBe(409);
  });

  it("concurrent requests with the same key converge on exactly one booking", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);
    const body = { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T11:00:00+00:00` };
    const key = "idem-key-concurrent";

    const [a, b] = await Promise.all([
      createBooking(customer.cookie, body, { "Idempotency-Key": key }),
      createBooking(customer.cookie, body, { "Idempotency-Key": key }),
    ]);

    const statuses = [a.status, b.status].sort();
    // One creates (201), the other safely replays (200) — never two 201s,
    // never an error.
    expect(statuses).toEqual([200, 201]);

    const aJson = (await a.json()) as { booking: { id: string } };
    const bJson = (await b.json()) as { booking: { id: string } };
    expect(aJson.booking.id).toBe(bJson.booking.id);
  });

  it("a request without an Idempotency-Key is not deduplicated", async () => {
    const { provider, service, monday } = await setupBookableProvider();
    const customer = await asUser();
    const pet = await createPet(customer.cookie);

    // Two distinct slots so this isn't also exercising the overlap
    // constraint — this test is purely about idempotency-key absence.
    const first = await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T12:00:00+00:00` });
    const second = await createBooking(customer.cookie, { providerId: provider.id, serviceId: service.id, petId: pet.id, startAt: `${monday}T13:00:00+00:00` });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });
});

describe("concurrency — the mandatory double-booking race test", () => {
  it("exactly one of two concurrent requests for the same slot succeeds; the other gets a clean 409", async () => {
    const { owner, provider, service, monday } = await setupBookableProvider();
    const customerA = await asUser();
    const petA = await createPet(customerA.cookie);
    const customerB = await asUser();
    const petB = await createPet(customerB.cookie);

    const startAt = `${monday}T15:00:00+00:00`;

    const [resA, resB] = await Promise.all([
      createBooking(customerA.cookie, { providerId: provider.id, serviceId: service.id, petId: petA.id, startAt }),
      createBooking(customerB.cookie, { providerId: provider.id, serviceId: service.id, petId: petB.id, startAt }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    // No raw database error leaked through on the loser.
    const loser = resA.status === 409 ? resA : resB;
    const loserJson = (await loser.json()) as { error: string };
    expect(loserJson.error).toBeTruthy();
    expect(loserJson.error.toLowerCase()).not.toContain("constraint");
    expect(loserJson.error.toLowerCase()).not.toContain("postgres");

    // Exactly one booking exists in the database for this exact
    // appointment (queried via the provider owner's view) — the
    // database, not just the HTTP responses, is the actual proof.
    const list = await app.request(`/api/bookings?providerId=${provider.id}`, { headers: { cookie: owner.cookie } });
    const listJson = (await list.json()) as { bookings: Array<{ startAt: string; status: string }> };
    const matching = listJson.bookings.filter(
      (b) => b.startAt === new Date(startAt).toISOString() && b.status === "CONFIRMED",
    );
    expect(matching).toHaveLength(1);
  });
});
