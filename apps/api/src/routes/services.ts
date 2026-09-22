import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { createServiceSchema, updateServiceSchema } from "@pawlink/shared";
import type { AppEnv } from "../types.js";
import type { DbClient } from "../db/client.js";
import { providers, services } from "../db/schema.js";
import { toPublicService } from "../lib/service.js";
import { SESSION_COOKIE_NAME } from "../lib/session.js";
import { createRequireAuth, resolveUser } from "../middleware/auth.js";

const uuidSchema = z.string().uuid();

// Same information-hiding rule used throughout: an id that's syntactically
// valid but doesn't resolve to something the caller may see/act on returns
// 404, never 403, so a caller can't distinguish "not yours" / "doesn't
// exist" / "exists but hidden".
const PROVIDER_NOT_FOUND = { error: "Provider not found" } as const;
const SERVICE_NOT_FOUND = { error: "Service not found" } as const;

export function createServiceRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);

  async function getRequester(c: Context<AppEnv>) {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    return resolveUser(db, token);
  }

  async function loadProvider(c: Context<AppEnv>) {
    const idResult = uuidSchema.safeParse(c.req.param("providerId"));
    if (!idResult.success) {
      return { error: c.json({ error: "Invalid provider id" }, 400) } as const;
    }
    const provider = await db.query.providers.findFirst({ where: eq(providers.id, idResult.data) });
    if (!provider) {
      return { error: c.json(PROVIDER_NOT_FOUND, 404) } as const;
    }
    return { provider } as const;
  }

  function isOwnerOrAdminOf(provider: { ownerUserId: string }, requester: { id: string; role: string } | null) {
    return requester !== null && (requester.id === provider.ownerUserId || requester.role === "ADMIN");
  }

  // Public discovery: active services of an active, publicly-visible
  // provider. The owner/an admin additionally sees their own inactive
  // services here (their management view), and can see the full catalog
  // even if the provider itself is currently INACTIVE/SUSPENDED.
  app.get("/", async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const { provider } = loaded;

    const requester = await getRequester(c);
    const privileged = isOwnerOrAdminOf(provider, requester);

    if (provider.status !== "ACTIVE" && !privileged) {
      return c.json(PROVIDER_NOT_FOUND, 404);
    }

    const conditions = [eq(services.providerId, provider.id)];
    if (!privileged) conditions.push(eq(services.active, true));

    const rows = await db.query.services.findMany({
      where: and(...conditions),
      orderBy: (s, { asc }) => [asc(s.createdAt)],
    });

    return c.json({ services: rows.map(toPublicService) }, 200);
  });

  app.post("/", requireAuth, async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const { provider } = loaded;

    const user = c.get("user");
    if (!isOwnerOrAdminOf(provider, user)) {
      return c.json(PROVIDER_NOT_FOUND, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = createServiceSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    // providerId is never read from the request body — createServiceSchema
    // has no such field. It comes solely from the URL, and ownership of
    // that provider was already verified above against the session.
    const [inserted] = await db
      .insert(services)
      .values({ ...parsed.data, providerId: provider.id })
      .returning();

    return c.json({ service: toPublicService(inserted) }, 201);
  });

  app.get("/:serviceId", async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const { provider } = loaded;

    const serviceIdResult = uuidSchema.safeParse(c.req.param("serviceId"));
    if (!serviceIdResult.success) {
      return c.json({ error: "Invalid service id" }, 400);
    }

    const requester = await getRequester(c);
    const privileged = isOwnerOrAdminOf(provider, requester);

    if (provider.status !== "ACTIVE" && !privileged) {
      return c.json(PROVIDER_NOT_FOUND, 404);
    }

    // Scoping by BOTH id and providerId is what makes a service id from a
    // different provider resolve to nothing here, even though the id
    // itself is real — this is the direct defense against
    // /providers/:providerId/services/:serviceId being used with a
    // serviceId that belongs to some other provider.
    const service = await db.query.services.findFirst({
      where: and(eq(services.id, serviceIdResult.data), eq(services.providerId, provider.id)),
    });
    if (!service) {
      return c.json(SERVICE_NOT_FOUND, 404);
    }
    if (!service.active && !privileged) {
      return c.json(SERVICE_NOT_FOUND, 404);
    }

    return c.json({ service: toPublicService(service) }, 200);
  });

  app.patch("/:serviceId", requireAuth, async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const { provider } = loaded;

    const serviceIdResult = uuidSchema.safeParse(c.req.param("serviceId"));
    if (!serviceIdResult.success) {
      return c.json({ error: "Invalid service id" }, 400);
    }

    const user = c.get("user");
    if (!isOwnerOrAdminOf(provider, user)) {
      return c.json(PROVIDER_NOT_FOUND, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = updateServiceSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }
    if (Object.keys(parsed.data).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const existing = await db.query.services.findFirst({
      where: and(eq(services.id, serviceIdResult.data), eq(services.providerId, provider.id)),
    });
    if (!existing) {
      return c.json(SERVICE_NOT_FOUND, 404);
    }

    const [updated] = await db
      .update(services)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(services.id, serviceIdResult.data))
      .returning();

    return c.json({ service: toPublicService(updated) }, 200);
  });

  // Soft delete: sets active=false rather than removing the row, so a
  // future booking that referenced this exact service never ends up
  // pointing at a vanished record. Reactivation is just PATCH
  // {active:true}, not a separate endpoint.
  app.delete("/:serviceId", requireAuth, async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const { provider } = loaded;

    const serviceIdResult = uuidSchema.safeParse(c.req.param("serviceId"));
    if (!serviceIdResult.success) {
      return c.json({ error: "Invalid service id" }, 400);
    }

    const user = c.get("user");
    if (!isOwnerOrAdminOf(provider, user)) {
      return c.json(PROVIDER_NOT_FOUND, 404);
    }

    const existing = await db.query.services.findFirst({
      where: and(eq(services.id, serviceIdResult.data), eq(services.providerId, provider.id)),
    });
    if (!existing) {
      return c.json(SERVICE_NOT_FOUND, 404);
    }

    const [updated] = await db
      .update(services)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(services.id, serviceIdResult.data))
      .returning();

    return c.json({ success: true, service: toPublicService(updated) }, 200);
  });

  return app;
}
