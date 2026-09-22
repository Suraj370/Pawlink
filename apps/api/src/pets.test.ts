import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestApp, registerAndLogin } from "./test-helpers.js";
import { users } from "./db/schema.js";

const { app, db } = createTestApp();

const createdEmails: string[] = [];

afterAll(async () => {
  if (createdEmails.length === 0) return;
  for (const email of createdEmails) {
    // Cascades to that user's pets via the pets.owner_id FK.
    await db.delete(users).where(eq(users.email, email));
  }
});

async function asUser() {
  const session = await registerAndLogin(app);
  createdEmails.push(session.email);
  return session;
}

function validPetPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Fido",
    species: "Dog",
    breed: "Labrador",
    sex: "MALE",
    dateOfBirth: "2020-05-01",
    weight: 25.5,
    photoUrl: "https://example.com/fido.jpg",
    ...overrides,
  };
}

async function createPet(cookie: string, overrides: Record<string, unknown> = {}) {
  return app.request("/api/pets", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(validPetPayload(overrides)),
  });
}

describe("POST /api/pets", () => {
  it("lets an authenticated user create a pet", async () => {
    const { cookie, userId } = await asUser();
    const res = await createPet(cookie);

    expect(res.status).toBe(201);
    const json = (await res.json()) as { pet: Record<string, unknown> };
    expect(json.pet.name).toBe("Fido");
    expect(json.pet.ownerId).toBe(userId);
    expect(json.pet.id).toBeTruthy();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/pets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPetPayload()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects missing required fields", async () => {
    const { cookie } = await asUser();
    const res = await createPet(cookie, { name: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a negative weight", async () => {
    const { cookie } = await asUser();
    const res = await createPet(cookie, { weight: -5 });
    expect(res.status).toBe(400);
  });

  it("rejects an unreasonably large weight", async () => {
    const { cookie } = await asUser();
    const res = await createPet(cookie, { weight: 999_999_999 });
    expect(res.status).toBe(400);
  });

  it("rejects a future date of birth", async () => {
    const { cookie } = await asUser();
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString().slice(0, 10);
    const res = await createPet(cookie, { dateOfBirth: futureDate });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid photo URL", async () => {
    const { cookie } = await asUser();
    const res = await createPet(cookie, { photoUrl: "not-a-url" });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const { cookie } = await asUser();
    const res = await app.request("/api/pets", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("silently drops unknown fields instead of erroring", async () => {
    const { cookie } = await asUser();
    const res = await createPet(cookie, { thisFieldDoesNotExist: "surprise" });
    expect(res.status).toBe(201);
  });

  it("ignores a client-supplied ownerId and always uses the authenticated user", async () => {
    const { cookie, userId } = await asUser();
    const otherSession = await asUser();

    const res = await createPet(cookie, { ownerId: otherSession.userId });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { pet: { ownerId: string } };
    expect(json.pet.ownerId).toBe(userId);
    expect(json.pet.ownerId).not.toBe(otherSession.userId);
  });
});

describe("GET /api/pets", () => {
  it("lists only the caller's own pets", async () => {
    const { cookie } = await asUser();
    await createPet(cookie, { name: "Pet One" });
    await createPet(cookie, { name: "Pet Two" });

    const otherSession = await asUser();
    await createPet(otherSession.cookie, { name: "Someone Else's Pet" });

    const res = await app.request("/api/pets", { headers: { cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pets: Array<{ name: string }> };
    const names = json.pets.map((p) => p.name);
    expect(names).toContain("Pet One");
    expect(names).toContain("Pet Two");
    expect(names).not.toContain("Someone Else's Pet");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/pets");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/pets/:id", () => {
  it("returns a pet the caller owns", async () => {
    const { cookie } = await asUser();
    const created = await createPet(cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const res = await app.request(`/api/pets/${pet.id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pet: { id: string } };
    expect(json.pet.id).toBe(pet.id);
  });

  it("returns 404 for another user's pet (never 403)", async () => {
    const ownerSession = await asUser();
    const created = await createPet(ownerSession.cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const attackerSession = await asUser();
    const res = await app.request(`/api/pets/${pet.id}`, {
      headers: { cookie: attackerSession.cookie },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a nonexistent (but well-formed) pet id", async () => {
    const { cookie } = await asUser();
    const res = await app.request("/api/pets/00000000-0000-0000-0000-000000000000", {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed pet id", async () => {
    const { cookie } = await asUser();
    const res = await app.request("/api/pets/not-a-uuid", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request", async () => {
    const { cookie } = await asUser();
    const created = await createPet(cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const res = await app.request(`/api/pets/${pet.id}`);
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/pets/:id", () => {
  it("lets the owner update their pet", async () => {
    const { cookie } = await asUser();
    const created = await createPet(cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const res = await app.request(`/api/pets/${pet.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Updated Name", weight: 30 }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pet: { name: string; weight: number } };
    expect(json.pet.name).toBe("Updated Name");
    expect(json.pet.weight).toBe(30);
  });

  it("prevents a non-owner from updating the pet", async () => {
    const ownerSession = await asUser();
    const created = await createPet(ownerSession.cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const attackerSession = await asUser();
    const res = await app.request(`/api/pets/${pet.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: attackerSession.cookie },
      body: JSON.stringify({ name: "Hijacked" }),
    });
    expect(res.status).toBe(404);

    const verify = await app.request(`/api/pets/${pet.id}`, {
      headers: { cookie: ownerSession.cookie },
    });
    const json = (await verify.json()) as { pet: { name: string } };
    expect(json.pet.name).toBe("Fido");
  });

  it("cannot be used to change ownerId", async () => {
    const ownerSession = await asUser();
    const attackerSession = await asUser();
    const created = await createPet(ownerSession.cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const res = await app.request(`/api/pets/${pet.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: ownerSession.cookie },
      body: JSON.stringify({ ownerId: attackerSession.userId }),
    });
    // ownerId isn't part of updatePetSchema, so this is an empty update.
    expect(res.status).toBe(400);
  });

  it("rejects an invalid update", async () => {
    const { cookie } = await asUser();
    const created = await createPet(cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const res = await app.request(`/api/pets/${pet.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ weight: -1 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty update body", async () => {
    const { cookie } = await asUser();
    const created = await createPet(cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const res = await app.request(`/api/pets/${pet.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/pets/:id", () => {
  it("lets the owner delete their pet", async () => {
    const { cookie } = await asUser();
    const created = await createPet(cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const res = await app.request(`/api/pets/${pet.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const verify = await app.request(`/api/pets/${pet.id}`, { headers: { cookie } });
    expect(verify.status).toBe(404);
  });

  it("prevents a non-owner from deleting the pet", async () => {
    const ownerSession = await asUser();
    const created = await createPet(ownerSession.cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const attackerSession = await asUser();
    const res = await app.request(`/api/pets/${pet.id}`, {
      method: "DELETE",
      headers: { cookie: attackerSession.cookie },
    });
    expect(res.status).toBe(404);

    const verify = await app.request(`/api/pets/${pet.id}`, {
      headers: { cookie: ownerSession.cookie },
    });
    expect(verify.status).toBe(200);
  });

  it("returns 404 on a repeated delete", async () => {
    const { cookie } = await asUser();
    const created = await createPet(cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const first = await app.request(`/api/pets/${pet.id}`, { method: "DELETE", headers: { cookie } });
    expect(first.status).toBe(200);

    const second = await app.request(`/api/pets/${pet.id}`, { method: "DELETE", headers: { cookie } });
    expect(second.status).toBe(404);
  });

  it("rejects an unauthenticated request", async () => {
    const { cookie } = await asUser();
    const created = await createPet(cookie);
    const { pet } = (await created.json()) as { pet: { id: string } };

    const res = await app.request(`/api/pets/${pet.id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});
