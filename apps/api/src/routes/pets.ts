import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createPetSchema, updatePetSchema } from "@pawlink/shared";
import type { AppEnv } from "../types.js";
import type { DbClient } from "../db/client.js";
import { pets } from "../db/schema.js";
import { toPublicPet } from "../lib/pet.js";
import { createRequireAuth } from "../middleware/auth.js";

const petIdSchema = z.string().uuid();

// A pet ID that's syntactically valid but doesn't resolve to one of the
// caller's own pets returns 404, identically to a truly nonexistent ID.
// This intentionally never returns 403: telling a non-owner "that exists
// but isn't yours" would confirm which pet IDs are in use for other users,
// which is itself an information leak. Only a malformed ID (not a UUID at
// all) is treated as a distinct 400 validation error.
const NOT_FOUND = { error: "Pet not found" } as const;

export function createPetRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);

  app.use("*", requireAuth);

  async function findOwnedPet(petId: string, ownerId: string) {
    return db.query.pets.findFirst({
      where: and(eq(pets.id, petId), eq(pets.ownerId, ownerId)),
    });
  }

  app.get("/", async (c) => {
    const user = c.get("user");
    const rows = await db.query.pets.findMany({
      where: eq(pets.ownerId, user.id),
      orderBy: (pet, { desc }) => [desc(pet.createdAt)],
    });
    return c.json({ pets: rows.map(toPublicPet) }, 200);
  });

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = createPetSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    const user = c.get("user");
    // ownerId is never read from the request body — createPetSchema has no
    // such field, so the client structurally cannot supply one. Ownership
    // is derived solely from the authenticated session.
    const [inserted] = await db
      .insert(pets)
      .values({ ...parsed.data, ownerId: user.id })
      .returning();

    return c.json({ pet: toPublicPet(inserted) }, 201);
  });

  app.get("/:id", async (c) => {
    const idResult = petIdSchema.safeParse(c.req.param("id"));
    if (!idResult.success) {
      return c.json({ error: "Invalid pet id" }, 400);
    }

    const user = c.get("user");
    const pet = await findOwnedPet(idResult.data, user.id);
    if (!pet) {
      return c.json(NOT_FOUND, 404);
    }

    return c.json({ pet: toPublicPet(pet) }, 200);
  });

  app.patch("/:id", async (c) => {
    const idResult = petIdSchema.safeParse(c.req.param("id"));
    if (!idResult.success) {
      return c.json({ error: "Invalid pet id" }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = updatePetSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    if (Object.keys(parsed.data).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const user = c.get("user");
    const existing = await findOwnedPet(idResult.data, user.id);
    if (!existing) {
      return c.json(NOT_FOUND, 404);
    }

    const [updated] = await db
      .update(pets)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(pets.id, idResult.data), eq(pets.ownerId, user.id)))
      .returning();

    return c.json({ pet: toPublicPet(updated) }, 200);
  });

  app.delete("/:id", async (c) => {
    const idResult = petIdSchema.safeParse(c.req.param("id"));
    if (!idResult.success) {
      return c.json({ error: "Invalid pet id" }, 400);
    }

    const user = c.get("user");
    const existing = await findOwnedPet(idResult.data, user.id);
    if (!existing) {
      return c.json(NOT_FOUND, 404);
    }

    await db.delete(pets).where(and(eq(pets.id, idResult.data), eq(pets.ownerId, user.id)));

    return c.json({ success: true }, 200);
  });

  return app;
}
