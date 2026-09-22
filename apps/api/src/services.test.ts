import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestApp, registerAndLogin } from "./test-helpers.js";
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

async function createProvider(cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await app.request("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ businessName: "Test Provider", providerType: "GROOMER", ...overrides }),
  });
  const { provider } = (await res.json()) as { provider: { id: string } };
  return provider;
}

function validServicePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Full Grooming",
    description: "A complete grooming package",
    durationMinutes: 90,
    priceMinor: 129900,
    currency: "INR",
    ...overrides,
  };
}

async function createService(cookie: string, providerId: string, overrides: Record<string, unknown> = {}) {
  return app.request(`/api/providers/${providerId}/services`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(validServicePayload(overrides)),
  });
}

async function setupProviderWithService(overrides: Record<string, unknown> = {}) {
  const owner = await asUser();
  const provider = await createProvider(owner.cookie);
  const res = await createService(owner.cookie, provider.id, overrides);
  const { service } = (await res.json()) as { service: { id: string } };
  return { owner, provider, service };
}

describe("POST /api/providers/:providerId/services", () => {
  it("lets the provider owner create a service", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);

    const res = await createService(owner.cookie, provider.id);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { service: Record<string, unknown> };
    expect(json.service.name).toBe("Full Grooming");
    expect(json.service.providerId).toBe(provider.id);
    expect(json.service.priceMinor).toBe(129900);
    expect(json.service.active).toBe(true);
  });

  it("rejects an unauthenticated request", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);

    const res = await app.request(`/api/providers/${provider.id}/services`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validServicePayload()),
    });
    expect(res.status).toBe(401);
  });

  it("prevents a different provider owner from creating a service", async () => {
    const ownerA = await asUser();
    const providerA = await createProvider(ownerA.cookie);
    const ownerB = await asUser();

    const res = await createService(ownerB.cookie, providerA.id);
    expect(res.status).toBe(404);

    const list = await app.request(`/api/providers/${providerA.id}/services`);
    const json = (await list.json()) as { services: unknown[] };
    expect(json.services).toHaveLength(0);
  });

  it("rejects an empty name", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createService(owner.cookie, provider.id, { name: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a zero duration", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createService(owner.cookie, provider.id, { durationMinutes: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects a negative duration", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createService(owner.cookie, provider.id, { durationMinutes: -30 });
    expect(res.status).toBe(400);
  });

  it("rejects a fractional duration", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createService(owner.cookie, provider.id, { durationMinutes: 45.5 });
    expect(res.status).toBe(400);
  });

  it("rejects a negative price", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createService(owner.cookie, provider.id, { priceMinor: -100 });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid currency", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createService(owner.cookie, provider.id, { currency: "notacurrency" });
    expect(res.status).toBe(400);
  });

  it("rejects an unreasonably huge price", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createService(owner.cookie, provider.id, { priceMinor: 999_999_999_999 });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await app.request(`/api/providers/${provider.id}/services`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("silently strips unknown fields", async () => {
    const owner = await asUser();
    const provider = await createProvider(owner.cookie);
    const res = await createService(owner.cookie, provider.id, { hackerField: "pwn" });
    expect(res.status).toBe(201);
  });

  it("ignores a client-supplied providerId in the body", async () => {
    const owner = await asUser();
    const providerA = await createProvider(owner.cookie);
    const other = await asUser();
    const providerB = await createProvider(other.cookie);

    const res = await createService(owner.cookie, providerA.id, { providerId: providerB.id });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { service: { providerId: string } };
    expect(json.service.providerId).toBe(providerA.id);
  });

  it("returns 404 for a wrong/nonexistent provider id", async () => {
    const owner = await asUser();
    const res = await createService(owner.cookie, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed provider id", async () => {
    const owner = await asUser();
    const res = await createService(owner.cookie, "not-a-uuid");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/providers/:providerId/services", () => {
  it("publicly lists active services without authentication", async () => {
    const { provider, service } = await setupProviderWithService();
    const res = await app.request(`/api/providers/${provider.id}/services`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { services: Array<{ id: string }> };
    expect(json.services.some((s) => s.id === service.id)).toBe(true);
  });

  it("hides inactive services from public discovery", async () => {
    const { owner, provider, service } = await setupProviderWithService();
    await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });

    const res = await app.request(`/api/providers/${provider.id}/services`);
    const json = (await res.json()) as { services: Array<{ id: string }> };
    expect(json.services.some((s) => s.id === service.id)).toBe(false);
  });

  it("lets the provider owner see their own inactive services", async () => {
    const { owner, provider, service } = await setupProviderWithService();
    await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });

    const res = await app.request(`/api/providers/${provider.id}/services`, {
      headers: { cookie: owner.cookie },
    });
    const json = (await res.json()) as { services: Array<{ id: string; active: boolean }> };
    const found = json.services.find((s) => s.id === service.id);
    expect(found).toBeDefined();
    expect(found?.active).toBe(false);
  });
});

describe("GET /api/providers/:providerId/services/:serviceId", () => {
  it("is publicly viewable when active", async () => {
    const { provider, service } = await setupProviderWithService();
    const res = await app.request(`/api/providers/${provider.id}/services/${service.id}`);
    expect(res.status).toBe(200);
  });

  it("returns 404 for a service accessed through the wrong provider", async () => {
    const { service } = await setupProviderWithService();
    const otherOwner = await asUser();
    const otherProvider = await createProvider(otherOwner.cookie);

    const res = await app.request(`/api/providers/${otherProvider.id}/services/${service.id}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a nonexistent service", async () => {
    const { provider } = await setupProviderWithService();
    const res = await app.request(`/api/providers/${provider.id}/services/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed service id", async () => {
    const { provider } = await setupProviderWithService();
    const res = await app.request(`/api/providers/${provider.id}/services/not-a-uuid`);
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/providers/:providerId/services/:serviceId", () => {
  it("lets the owner update the service", async () => {
    const { owner, provider, service } = await setupProviderWithService();
    const res = await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ name: "Updated Name", priceMinor: 50000 }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { service: { name: string; priceMinor: number } };
    expect(json.service.name).toBe("Updated Name");
    expect(json.service.priceMinor).toBe(50000);
  });

  it("prevents a non-owner from updating the service", async () => {
    const { provider, service } = await setupProviderWithService();
    const attacker = await asUser();

    const res = await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: attacker.cookie },
      body: JSON.stringify({ name: "Hijacked" }),
    });
    expect(res.status).toBe(404);

    const verify = await app.request(`/api/providers/${provider.id}/services/${service.id}`);
    const json = (await verify.json()) as { service: { name: string } };
    expect(json.service.name).toBe("Full Grooming");
  });

  it("prevents modifying a service through a different provider's URL", async () => {
    const { owner, service } = await setupProviderWithService();
    const otherOwner = await asUser();
    const otherProvider = await createProvider(otherOwner.cookie);

    // Even the ORIGINAL owner, using the wrong provider id in the URL,
    // must not be able to reach a service that belongs elsewhere.
    const res = await app.request(`/api/providers/${otherProvider.id}/services/${service.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ name: "Should Not Apply" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid update", async () => {
    const { owner, provider, service } = await setupProviderWithService();
    const res = await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ durationMinutes: -1 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty update body", async () => {
    const { owner, provider, service } = await setupProviderWithService();
    const res = await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("lets the owner reactivate a deactivated service via PATCH", async () => {
    const { owner, provider, service } = await setupProviderWithService();
    await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });

    const res = await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ active: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { service: { active: boolean } };
    expect(json.service.active).toBe(true);

    const publicRes = await app.request(`/api/providers/${provider.id}/services/${service.id}`);
    expect(publicRes.status).toBe(200);
  });
});

describe("DELETE /api/providers/:providerId/services/:serviceId (soft deactivation)", () => {
  it("lets the owner deactivate the service", async () => {
    const { owner, provider, service } = await setupProviderWithService();
    const res = await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { service: { active: boolean } };
    expect(json.service.active).toBe(false);

    // Row still exists (soft delete) — owner can still see it directly.
    const ownerRes = await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      headers: { cookie: owner.cookie },
    });
    expect(ownerRes.status).toBe(200);
  });

  it("prevents a non-owner from deactivating the service", async () => {
    const { provider, service } = await setupProviderWithService();
    const attacker = await asUser();

    const res = await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "DELETE",
      headers: { cookie: attacker.cookie },
    });
    expect(res.status).toBe(404);

    const verify = await app.request(`/api/providers/${provider.id}/services/${service.id}`);
    const json = (await verify.json()) as { service: { active: boolean } };
    expect(json.service.active).toBe(true);
  });

  it("removes the service from public listing once deactivated", async () => {
    const { owner, provider, service } = await setupProviderWithService();
    await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });

    const list = await app.request(`/api/providers/${provider.id}/services`);
    const json = (await list.json()) as { services: Array<{ id: string }> };
    expect(json.services.some((s) => s.id === service.id)).toBe(false);
  });

  it("rejects an unauthenticated request", async () => {
    const { provider, service } = await setupProviderWithService();
    const res = await app.request(`/api/providers/${provider.id}/services/${service.id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("is idempotent on repeated deactivation (double-click create is not double-billed)", async () => {
    const { owner, provider, service } = await setupProviderWithService();
    const first = await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/providers/${provider.id}/services/${service.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie },
    });
    expect(second.status).toBe(200);
  });
});

describe("cross-provider IDOR", () => {
  it("blocks the full attack matrix: modify, delete, create-under, and access-through-wrong-provider", async () => {
    const ownerA = await asUser();
    const providerA = await createProvider(ownerA.cookie, { businessName: "Provider A" });
    const createRes = await createService(ownerA.cookie, providerA.id, { name: "Service A" });
    const { service: serviceA } = (await createRes.json()) as { service: { id: string } };

    const userB = await asUser();

    const modifyRes = await app.request(`/api/providers/${providerA.id}/services/${serviceA.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: userB.cookie },
      body: JSON.stringify({ name: "Hijacked" }),
    });
    expect(modifyRes.status).toBe(404);

    const deleteRes = await app.request(`/api/providers/${providerA.id}/services/${serviceA.id}`, {
      method: "DELETE",
      headers: { cookie: userB.cookie },
    });
    expect(deleteRes.status).toBe(404);

    const createUnderRes = await createService(userB.cookie, providerA.id, { name: "Planted" });
    expect(createUnderRes.status).toBe(404);

    // Provider A's own services list must not contain User B's attempted plant.
    const list = await app.request(`/api/providers/${providerA.id}/services`, { headers: { cookie: ownerA.cookie } });
    const listJson = (await list.json()) as { services: Array<{ name: string }> };
    expect(listJson.services.some((s) => s.name === "Planted")).toBe(false);

    // Service A is completely untouched.
    const verify = await app.request(`/api/providers/${providerA.id}/services/${serviceA.id}`);
    const verifyJson = (await verify.json()) as { service: { name: string; active: boolean } };
    expect(verifyJson.service.name).toBe("Service A");
    expect(verifyJson.service.active).toBe(true);
  });
});
