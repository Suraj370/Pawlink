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

function validProviderPayload(overrides: Record<string, unknown> = {}) {
  return {
    businessName: "Fido's Vet Clinic",
    providerType: "VET",
    description: "Full-service veterinary care",
    phone: "5551234567",
    email: "contact@fidosvet.example.com",
    address: "123 Main St",
    city: "Springfield",
    state: "IL",
    postalCode: "62701",
    latitude: 39.7817,
    longitude: -89.6501,
    ...overrides,
  };
}

async function createProvider(cookie: string, overrides: Record<string, unknown> = {}) {
  return app.request("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(validProviderPayload(overrides)),
  });
}

describe("POST /api/providers", () => {
  it("lets an authenticated user create a provider", async () => {
    const { cookie } = await asUser();
    const res = await createProvider(cookie);

    expect(res.status).toBe(201);
    const json = (await res.json()) as { provider: Record<string, unknown> };
    expect(json.provider.businessName).toBe("Fido's Vet Clinic");
    expect(json.provider.status).toBe("ACTIVE");
    expect(json.provider.isOwner).toBe(true);
    expect(json.provider).not.toHaveProperty("ownerUserId");
    expect(JSON.stringify(json)).not.toContain("ownerUserId");
    expect(JSON.stringify(json)).not.toContain("owner_user_id");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validProviderPayload()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid provider type", async () => {
    const { cookie } = await asUser();
    const res = await createProvider(cookie, { providerType: "LOCKSMITH" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty business name", async () => {
    const { cookie } = await asUser();
    const res = await createProvider(cookie, { businessName: "" });
    expect(res.status).toBe(400);
  });

  it("rejects out-of-range latitude", async () => {
    const { cookie } = await asUser();
    const res = await createProvider(cookie, { latitude: 999 });
    expect(res.status).toBe(400);
  });

  it("rejects out-of-range longitude", async () => {
    const { cookie } = await asUser();
    const res = await createProvider(cookie, { longitude: -999 });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid email", async () => {
    const { cookie } = await asUser();
    const res = await createProvider(cookie, { email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const { cookie } = await asUser();
    const res = await app.request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("ignores a client-supplied ownerUserId and always uses the authenticated user", async () => {
    const { cookie } = await asUser();
    const otherSession = await asUser();

    const res = await createProvider(cookie, { ownerUserId: otherSession.userId });
    expect(res.status).toBe(201);

    // Verify via the owner's own authenticated GET that isOwner is true
    // (i.e. it was actually attributed to the creator, not the injected id).
    const created = (await res.json()) as { provider: { id: string } };
    const check = await app.request(`/api/providers/${created.provider.id}`, { headers: { cookie } });
    const checkJson = (await check.json()) as { provider: { isOwner: boolean } };
    expect(checkJson.provider.isOwner).toBe(true);
  });

  it("ignores a client-supplied initial status", async () => {
    const { cookie } = await asUser();
    const res = await createProvider(cookie, { status: "SUSPENDED" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { provider: { status: string } };
    expect(json.provider.status).toBe("ACTIVE");
  });
});

describe("GET /api/providers", () => {
  it("publicly lists active providers without authentication", async () => {
    const { cookie } = await asUser();
    await createProvider(cookie, { businessName: "Public Listing Test", city: "Metropolis" });

    const res = await app.request("/api/providers?city=Metropolis");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { providers: Array<{ businessName: string }>; total: number };
    expect(json.providers.some((p) => p.businessName === "Public Listing Test")).toBe(true);
  });

  it("filters by providerType", async () => {
    const { cookie } = await asUser();
    const unique = `Groomer-${Date.now()}`;
    await createProvider(cookie, { businessName: unique, providerType: "GROOMER" });

    const res = await app.request(`/api/providers?providerType=GROOMER`);
    const json = (await res.json()) as { providers: Array<{ businessName: string; providerType: string }> };
    expect(json.providers.every((p) => p.providerType === "GROOMER")).toBe(true);
    expect(json.providers.some((p) => p.businessName === unique)).toBe(true);
  });

  it("never returns non-active providers to the public, even when status is requested", async () => {
    const { cookie } = await asUser();
    const created = await createProvider(cookie, { businessName: `Inactive-${Date.now()}` });
    const { provider } = (await created.json()) as { provider: { id: string; businessName: string } };
    await app.request(`/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ status: "INACTIVE" }),
    });

    const res = await app.request(`/api/providers?status=INACTIVE`);
    const json = (await res.json()) as { providers: Array<{ businessName: string }> };
    expect(json.providers.some((p) => p.businessName === provider.businessName)).toBe(false);
  });

  it("paginates results", async () => {
    const res = await app.request("/api/providers?page=1&pageSize=1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { providers: unknown[]; page: number; pageSize: number };
    expect(json.providers.length).toBeLessThanOrEqual(1);
    expect(json.page).toBe(1);
    expect(json.pageSize).toBe(1);
  });

  it("clamps an extremely large page size instead of erroring", async () => {
    const res = await app.request("/api/providers?pageSize=999999999");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pageSize: number };
    expect(json.pageSize).toBeLessThanOrEqual(50);
  });

  it("defaults an invalid page number instead of erroring", async () => {
    const res = await app.request("/api/providers?page=-5");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { page: number };
    expect(json.page).toBe(1);
  });
});

describe("GET /api/providers/:id", () => {
  it("is publicly viewable when active", async () => {
    const { cookie } = await asUser();
    const created = await createProvider(cookie);
    const { provider } = (await created.json()) as { provider: { id: string } };

    const res = await app.request(`/api/providers/${provider.id}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { provider: { isOwner: boolean } };
    expect(json.provider.isOwner).toBe(false);
  });

  it("does not expose ownerUserId to the public", async () => {
    const { cookie } = await asUser();
    const created = await createProvider(cookie);
    const { provider } = (await created.json()) as { provider: { id: string } };

    const res = await app.request(`/api/providers/${provider.id}`);
    const text = await res.text();
    expect(text).not.toContain("ownerUserId");
    expect(text).not.toContain("owner_user_id");
  });

  it("returns 404 for a nonexistent provider", async () => {
    const res = await app.request("/api/providers/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed provider id", async () => {
    const res = await app.request("/api/providers/not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("hides an inactive provider from the public but shows it to its owner", async () => {
    const { cookie } = await asUser();
    const created = await createProvider(cookie);
    const { provider } = (await created.json()) as { provider: { id: string } };
    await app.request(`/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ status: "INACTIVE" }),
    });

    const publicRes = await app.request(`/api/providers/${provider.id}`);
    expect(publicRes.status).toBe(404);

    const ownerRes = await app.request(`/api/providers/${provider.id}`, { headers: { cookie } });
    expect(ownerRes.status).toBe(200);
    const ownerJson = (await ownerRes.json()) as { provider: { status: string; isOwner: boolean } };
    expect(ownerJson.provider.status).toBe("INACTIVE");
    expect(ownerJson.provider.isOwner).toBe(true);
  });
});

describe("PATCH /api/providers/:id", () => {
  it("lets the owner update their provider", async () => {
    const { cookie } = await asUser();
    const created = await createProvider(cookie);
    const { provider } = (await created.json()) as { provider: { id: string } };

    const res = await app.request(`/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ businessName: "Updated Name" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { provider: { businessName: string } };
    expect(json.provider.businessName).toBe("Updated Name");
  });

  it("prevents a non-owner from updating the provider", async () => {
    const ownerSession = await asUser();
    const created = await createProvider(ownerSession.cookie);
    const { provider } = (await created.json()) as { provider: { id: string } };

    const attackerSession = await asUser();
    const res = await app.request(`/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: attackerSession.cookie },
      body: JSON.stringify({ businessName: "Hijacked" }),
    });
    expect(res.status).toBe(404);

    const verify = await app.request(`/api/providers/${provider.id}`);
    const json = (await verify.json()) as { provider: { businessName: string } };
    expect(json.provider.businessName).toBe("Fido's Vet Clinic");
  });

  it("rejects invalid input", async () => {
    const { cookie } = await asUser();
    const created = await createProvider(cookie);
    const { provider } = (await created.json()) as { provider: { id: string } };

    const res = await app.request(`/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ latitude: 999 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty update body", async () => {
    const { cookie } = await asUser();
    const created = await createProvider(cookie);
    const { provider } = (await created.json()) as { provider: { id: string } };

    const res = await app.request(`/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  describe("status transitions", () => {
    it("lets the owner toggle between ACTIVE and INACTIVE", async () => {
      const { cookie } = await asUser();
      const created = await createProvider(cookie);
      const { provider } = (await created.json()) as { provider: { id: string } };

      const toInactive = await app.request(`/api/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ status: "INACTIVE" }),
      });
      expect(toInactive.status).toBe(200);

      const toActive = await app.request(`/api/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ status: "ACTIVE" }),
      });
      expect(toActive.status).toBe(200);
    });

    it("rejects a normal owner setting their own provider to SUSPENDED", async () => {
      const { cookie } = await asUser();
      const created = await createProvider(cookie);
      const { provider } = (await created.json()) as { provider: { id: string } };

      const res = await app.request(`/api/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ status: "SUSPENDED" }),
      });
      // SUSPENDED isn't even in the owner-facing schema's status enum.
      expect(res.status).toBe(400);
    });

    it("lets an admin suspend a provider", async () => {
      const ownerSession = await asUser();
      const created = await createProvider(ownerSession.cookie);
      const { provider } = (await created.json()) as { provider: { id: string } };

      const adminSession = await asAdmin();
      const res = await app.request(`/api/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: adminSession.cookie },
        body: JSON.stringify({ status: "SUSPENDED" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { provider: { status: string } };
      expect(json.provider.status).toBe("SUSPENDED");
    });

    it("prevents the owner from un-suspending their own provider", async () => {
      const ownerSession = await asUser();
      const created = await createProvider(ownerSession.cookie);
      const { provider } = (await created.json()) as { provider: { id: string } };

      const adminSession = await asAdmin();
      await app.request(`/api/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: adminSession.cookie },
        body: JSON.stringify({ status: "SUSPENDED" }),
      });

      const res = await app.request(`/api/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: ownerSession.cookie },
        body: JSON.stringify({ status: "ACTIVE" }),
      });
      expect(res.status).toBe(403);

      const verify = await app.request(`/api/providers/${provider.id}`, { headers: { cookie: ownerSession.cookie } });
      const json = (await verify.json()) as { provider: { status: string } };
      expect(json.provider.status).toBe("SUSPENDED");
    });
  });
});

describe("DELETE /api/providers/:id (soft deactivation)", () => {
  it("lets the owner deactivate their provider", async () => {
    const { cookie } = await asUser();
    const created = await createProvider(cookie);
    const { provider } = (await created.json()) as { provider: { id: string } };

    const res = await app.request(`/api/providers/${provider.id}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { provider: { status: string } };
    expect(json.provider.status).toBe("INACTIVE");

    // The row still exists (soft delete) — it's just no longer public.
    const publicRes = await app.request(`/api/providers/${provider.id}`);
    expect(publicRes.status).toBe(404);
    const ownerRes = await app.request(`/api/providers/${provider.id}`, { headers: { cookie } });
    expect(ownerRes.status).toBe(200);
  });

  it("prevents a non-owner from deactivating the provider", async () => {
    const ownerSession = await asUser();
    const created = await createProvider(ownerSession.cookie);
    const { provider } = (await created.json()) as { provider: { id: string } };

    const attackerSession = await asUser();
    const res = await app.request(`/api/providers/${provider.id}`, {
      method: "DELETE",
      headers: { cookie: attackerSession.cookie },
    });
    expect(res.status).toBe(404);

    const verify = await app.request(`/api/providers/${provider.id}`);
    expect(verify.status).toBe(200);
  });

  it("is idempotent on repeated deactivation", async () => {
    const { cookie } = await asUser();
    const created = await createProvider(cookie);
    const { provider } = (await created.json()) as { provider: { id: string } };

    const first = await app.request(`/api/providers/${provider.id}`, { method: "DELETE", headers: { cookie } });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/providers/${provider.id}`, { method: "DELETE", headers: { cookie } });
    expect(second.status).toBe(200);
  });

  it("rejects an unauthenticated request", async () => {
    const { cookie } = await asUser();
    const created = await createProvider(cookie);
    const { provider } = (await created.json()) as { provider: { id: string } };

    const res = await app.request(`/api/providers/${provider.id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});
