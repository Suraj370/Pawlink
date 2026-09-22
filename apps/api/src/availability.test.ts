import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestApp, promoteToAdmin, registerAndLogin } from "./test-helpers.js";
import { users } from "./db/schema.js";

const { app, db } = createTestApp();

const createdEmails: string[] = [];

afterAll(async () => {
  if (createdEmails.length === 0) return;
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

// Always at least two years out and always a Monday, so date-dependent
// tests never become flaky/stale regardless of when they run.
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
    body: JSON.stringify({ businessName: "Avail Test Provider", providerType: "VET", timezone: "UTC", ...overrides }),
  });
  const { provider } = (await res.json()) as { provider: { id: string } };
  return provider;
}

async function createService(cookie: string, providerId: string, overrides: Record<string, unknown> = {}) {
  const res = await app.request(`/api/providers/${providerId}/services`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name: "Consultation", durationMinutes: 60, priceMinor: 1000, ...overrides }),
  });
  const { service } = (await res.json()) as { service: { id: string } };
  return service;
}

async function createRule(cookie: string, providerId: string, overrides: Record<string, unknown> = {}) {
  return app.request(`/api/providers/${providerId}/availability/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00", ...overrides }),
  });
}

async function setupProviderServiceAndRule(monday = futureMonday()) {
  const owner = await asUser();
  const provider = await createProvider(owner.cookie);
  const service = await createService(owner.cookie, provider.id);
  const ruleRes = await createRule(owner.cookie, provider.id);
  const { rule } = (await ruleRes.json()) as { rule: { id: string } };
  return { owner, provider, service, rule, monday };
}

describe("GET /api/providers/:providerId/availability (calculation)", () => {
  it("returns the expected slots for a configured Monday schedule", async () => {
    const { provider, service, monday } = await setupProviderServiceAndRule();
    const res = await app.request(
      `/api/providers/${provider.id}/availability?date=${monday}&serviceId=${service.id}`,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      date: string;
      timezone: string;
      slotIntervalMinutes: number;
      slots: string[];
    };
    expect(json.date).toBe(monday);
    expect(json.timezone).toBe("UTC");
    expect(json.slotIntervalMinutes).toBe(30);
    expect(json.slots[0]).toBe(`${monday}T09:00:00+00:00`);
    expect(json.slots).not.toContain(`${monday}T16:30:00+00:00`); // 60-min service, window ends 17:00
    expect(json.slots).toContain(`${monday}T16:00:00+00:00`);
  });

  it("returns no slots for a day with no configured rule", async () => {
    const { provider, service } = await setupProviderServiceAndRule();
    // Pick a Tuesday two years out (no rule configured for Tuesday).
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() + 2);
    while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
    const tuesday = d.toISOString().slice(0, 10);

    const res = await app.request(`/api/providers/${provider.id}/availability?date=${tuesday}&serviceId=${service.id}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { slots: string[] };
    expect(json.slots).toEqual([]);
  });

  it("is unaffected by authentication (public endpoint)", async () => {
    const { provider, service, monday } = await setupProviderServiceAndRule();
    const res = await app.request(`/api/providers/${provider.id}/availability?date=${monday}&serviceId=${service.id}`);
    expect(res.status).toBe(200);
  });

  it("returns 404 when the provider is inactive", async () => {
    const { owner, provider, service, monday } = await setupProviderServiceAndRule();
    await app.request(`/api/providers/${provider.id}`, { method: "DELETE", headers: { cookie: owner.cookie } });

    const res = await app.request(`/api/providers/${provider.id}/availability?date=${monday}&serviceId=${service.id}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the provider is suspended", async () => {
    const { provider, service, monday } = await setupProviderServiceAndRule();
    const admin = await asAdmin();
    await app.request(`/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ status: "SUSPENDED" }),
    });

    const res = await app.request(`/api/providers/${provider.id}/availability?date=${monday}&serviceId=${service.id}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the service is inactive", async () => {
    const { owner, provider, service, monday } = await setupProviderServiceAndRule();
    await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });

    const res = await app.request(`/api/providers/${provider.id}/availability?date=${monday}&serviceId=${service.id}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the service belongs to a different provider", async () => {
    const { provider, monday } = await setupProviderServiceAndRule();
    const otherOwner = await asUser();
    const otherProvider = await createProvider(otherOwner.cookie);
    const otherService = await createService(otherOwner.cookie, otherProvider.id);

    const res = await app.request(
      `/api/providers/${provider.id}/availability?date=${monday}&serviceId=${otherService.id}`,
    );
    expect(res.status).toBe(404);
  });

  it("rejects an invalid date", async () => {
    const { provider, service } = await setupProviderServiceAndRule();
    const res = await app.request(`/api/providers/${provider.id}/availability?date=not-a-date&serviceId=${service.id}`);
    expect(res.status).toBe(400);
  });

  it("rejects a digit-shaped but impossible calendar date with 400, not a raw DB error", async () => {
    const { provider, service } = await setupProviderServiceAndRule();
    const res = await app.request(`/api/providers/${provider.id}/availability?date=2031-13-45&serviceId=${service.id}`);
    expect(res.status).toBe(400);
  });

  it("rejects February 30th", async () => {
    const { provider, service } = await setupProviderServiceAndRule();
    const res = await app.request(`/api/providers/${provider.id}/availability?date=2031-02-30&serviceId=${service.id}`);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed service id", async () => {
    const { provider, monday } = await setupProviderServiceAndRule();
    const res = await app.request(`/api/providers/${provider.id}/availability?date=${monday}&serviceId=not-a-uuid`);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed provider id", async () => {
    const { service, monday } = await setupProviderServiceAndRule();
    const res = await app.request(`/api/providers/not-a-uuid/availability?date=${monday}&serviceId=${service.id}`);
    expect(res.status).toBe(400);
  });

  it("applies a CLOSED exception over the weekly schedule", async () => {
    const { owner, provider, service, monday } = await setupProviderServiceAndRule();
    await app.request(`/api/providers/${provider.id}/availability/exceptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ date: monday, type: "CLOSED" }),
    });

    const res = await app.request(`/api/providers/${provider.id}/availability?date=${monday}&serviceId=${service.id}`);
    const json = (await res.json()) as { slots: string[] };
    expect(json.slots).toEqual([]);
  });

  it("applies a CUSTOM_HOURS exception instead of the weekly schedule", async () => {
    const { owner, provider, service, monday } = await setupProviderServiceAndRule();
    await app.request(`/api/providers/${provider.id}/availability/exceptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ date: monday, type: "CUSTOM_HOURS", startTime: "10:00", endTime: "12:00" }),
    });

    const res = await app.request(`/api/providers/${provider.id}/availability?date=${monday}&serviceId=${service.id}`);
    const json = (await res.json()) as { slots: string[] };
    expect(json.slots).not.toContain(`${monday}T09:00:00+00:00`);
    expect(json.slots[0]).toBe(`${monday}T10:00:00+00:00`);
  });
});

describe("weekly rules management", () => {
  it("lets the provider owner create a rule", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createRule(owner.cookie, provider.id);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { rule: { dayOfWeek: string; startTime: string } };
    expect(json.rule.dayOfWeek).toBe("MONDAY");
  });

  it("rejects an unauthenticated create", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await app.request(`/api/providers/${provider.id}/availability/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }),
    });
    expect(res.status).toBe(401);
  });

  it("prevents a different provider owner from creating a rule", async () => {
    const ownerA = await asUser();
    const providerA = await createProvider(ownerA.cookie);
    const ownerB = await asUser();

    const res = await createRule(ownerB.cookie, providerA.id);
    expect(res.status).toBe(404);
  });

  it("rejects end <= start", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createRule(owner.cookie, provider.id, { startTime: "17:00", endTime: "09:00" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid day of week", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createRule(owner.cookie, provider.id, { dayOfWeek: "FUNDAY" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid time format", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createRule(owner.cookie, provider.id, { startTime: "9am" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed provider id", async () => {
    const owner = await asUser();
    const res = await createRule(owner.cookie, "not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("rejects an overlapping window on the same day", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    await createRule(owner.cookie, provider.id, { startTime: "09:00", endTime: "13:00" });
    const res = await createRule(owner.cookie, provider.id, { startTime: "12:00", endTime: "18:00" });
    expect(res.status).toBe(409);
  });

  it("allows back-to-back (touching, non-overlapping) windows on the same day", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    await createRule(owner.cookie, provider.id, { startTime: "09:00", endTime: "13:00" });
    const res = await createRule(owner.cookie, provider.id, { startTime: "13:00", endTime: "18:00" });
    expect(res.status).toBe(201);
  });

  it("allows overlapping times on DIFFERENT days", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    await createRule(owner.cookie, provider.id, { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" });
    const res = await createRule(owner.cookie, provider.id, { dayOfWeek: "TUESDAY", startTime: "09:00", endTime: "17:00" });
    expect(res.status).toBe(201);
  });

  it("owner can update their own rule", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const created = await createRule(owner.cookie, provider.id);
    const { rule } = (await created.json()) as { rule: { id: string } };

    const res = await app.request(`/api/providers/${provider.id}/availability/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ dayOfWeek: "MONDAY", startTime: "10:00", endTime: "16:00" }),
    });
    expect(res.status).toBe(200);
  });

  it("prevents a non-owner from updating a rule", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const created = await createRule(owner.cookie, provider.id);
    const { rule } = (await created.json()) as { rule: { id: string } };

    const attacker = await asUser();
    const res = await app.request(`/api/providers/${provider.id}/availability/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: attacker.cookie },
      body: JSON.stringify({ dayOfWeek: "MONDAY", startTime: "10:00", endTime: "16:00" }),
    });
    expect(res.status).toBe(404);
  });

  it("owner can delete their own rule", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const created = await createRule(owner.cookie, provider.id);
    const { rule } = (await created.json()) as { rule: { id: string } };

    const res = await app.request(`/api/providers/${provider.id}/availability/rules/${rule.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });
    expect(res.status).toBe(200);
  });

  it("prevents a non-owner from deleting a rule", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const created = await createRule(owner.cookie, provider.id);
    const { rule } = (await created.json()) as { rule: { id: string } };

    const attacker = await asUser();
    const res = await app.request(`/api/providers/${provider.id}/availability/rules/${rule.id}`, {
      method: "DELETE",
      headers: { cookie: attacker.cookie },
    });
    expect(res.status).toBe(404);
  });

  it("prevents accessing a rule through a different provider's URL", async () => {
    const ownerA = await asUser();
    const providerA = await createProvider(ownerA.cookie);
    const created = await createRule(ownerA.cookie, providerA.id);
    const { rule } = (await created.json()) as { rule: { id: string } };

    const ownerB = await asUser();
    const providerB = await createProvider(ownerB.cookie);

    const res = await app.request(`/api/providers/${providerB.id}/availability/rules/${rule.id}`, {
      method: "DELETE",
      headers: { cookie: ownerB.cookie },
    });
    expect(res.status).toBe(404);
  });
});

describe("date exceptions management", () => {
  async function createException(cookie: string, providerId: string, overrides: Record<string, unknown> = {}) {
    return app.request(`/api/providers/${providerId}/availability/exceptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ date: "2030-10-02", type: "CLOSED", ...overrides }),
    });
  }

  it("lets the owner create a CLOSED exception", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createException(owner.cookie, provider.id);
    expect(res.status).toBe(201);
  });

  it("lets the owner create a CUSTOM_HOURS exception", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createException(owner.cookie, provider.id, {
      type: "CUSTOM_HOURS",
      startTime: "10:00",
      endTime: "15:00",
    });
    expect(res.status).toBe(201);
  });

  it("rejects CUSTOM_HOURS without times", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createException(owner.cookie, provider.id, { type: "CUSTOM_HOURS" });
    expect(res.status).toBe(400);
  });

  it("rejects CLOSED with times provided", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createException(owner.cookie, provider.id, { type: "CLOSED", startTime: "10:00", endTime: "12:00" });
    expect(res.status).toBe(400);
  });

  it("rejects an impossible calendar date, not a raw DB error", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createException(owner.cookie, provider.id, { date: "2031-02-30" });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate exception for the same date", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    await createException(owner.cookie, provider.id, { date: "2030-10-05" });
    const res = await createException(owner.cookie, provider.id, { date: "2030-10-05", type: "CUSTOM_HOURS", startTime: "10:00", endTime: "12:00" });
    expect(res.status).toBe(409);
  });

  it("rejects an unauthenticated create", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await app.request(`/api/providers/${provider.id}/availability/exceptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2030-10-02", type: "CLOSED" }),
    });
    expect(res.status).toBe(401);
  });

  it("prevents a different provider owner from creating an exception", async () => {
    const ownerA = await asUser();
    const providerA = await createProvider(ownerA.cookie);
    const ownerB = await asUser();

    const res = await createException(ownerB.cookie, providerA.id);
    expect(res.status).toBe(404);
  });

  it("owner can delete their own exception", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const created = await createException(owner.cookie, provider.id);
    const { exception } = (await created.json()) as { exception: { id: string } };

    const res = await app.request(`/api/providers/${provider.id}/availability/exceptions/${exception.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });
    expect(res.status).toBe(200);
  });

  it("prevents a non-owner from deleting an exception", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const created = await createException(owner.cookie, provider.id);
    const { exception } = (await created.json()) as { exception: { id: string } };

    const attacker = await asUser();
    const res = await app.request(`/api/providers/${provider.id}/availability/exceptions/${exception.id}`, {
      method: "DELETE",
      headers: { cookie: attacker.cookie },
    });
    expect(res.status).toBe(404);
  });

  it("prevents a different provider owner from modifying another provider's exception", async () => {
    const ownerA = await asUser();
    const providerA = await createProvider(ownerA.cookie);
    const created = await createException(ownerA.cookie, providerA.id);
    const { exception } = (await created.json()) as { exception: { id: string } };

    const ownerB = await asUser();
    const providerB = await createProvider(ownerB.cookie);

    const res = await app.request(`/api/providers/${providerB.id}/availability/exceptions/${exception.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: ownerB.cookie },
      body: JSON.stringify({ date: "2030-10-02", type: "CLOSED" }),
    });
    expect(res.status).toBe(404);
  });
});
