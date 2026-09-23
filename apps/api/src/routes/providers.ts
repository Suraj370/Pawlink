import { Hono, type Context } from "hono";
import { and, eq, ilike, sql } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import {
  adminUpdateProviderSchema,
  createProviderSchema,
  providerListQuerySchema,
  updateProviderSchema,
} from "@pawlink/shared";
import type { AppEnv } from "../types.js";
import type { DbClient } from "../db/client.js";
import { providers } from "../db/schema.js";
import { StatusTransitionError, assertStatusTransitionAllowed, toPublicProvider } from "../lib/provider.js";
import { getReviewAggregate, getReviewAggregates } from "../lib/review.js";
import { SESSION_COOKIE_NAME } from "../lib/session.js";
import { createRequireAuth, resolveUser } from "../middleware/auth.js";

const providerIdSchema = z.string().uuid();

// Same information-hiding rule as pets: a provider ID that's syntactically
// valid but either doesn't exist, or belongs to someone else, or isn't
// currently publicly visible, returns 404 — never 403 — so a caller can't
// distinguish "not yours" from "doesn't exist" from "exists but hidden".
const NOT_FOUND = { error: "Provider not found" } as const;

export function createProviderRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);

  async function getRequester(c: Context<AppEnv>) {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    return resolveUser(db, token);
  }

  // Public: only ever lists ACTIVE providers. Any client-supplied `status`
  // filter is intentionally ignored here rather than honored, so a
  // stranger can't use it to enumerate INACTIVE/SUSPENDED listings —
  // owners/admins manage non-active providers via GET/PATCH on a known id.
  app.get("/", async (c) => {
    const parsedQuery = providerListQuerySchema.safeParse({
      providerType: c.req.query("providerType") || undefined,
      city: c.req.query("city") || undefined,
      status: c.req.query("status") || undefined,
      page: c.req.query("page") ?? undefined,
      pageSize: c.req.query("pageSize") ?? undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: "Invalid query", fields: parsedQuery.error.flatten().fieldErrors }, 400);
    }

    const { providerType, city, page, pageSize } = parsedQuery.data;

    const conditions = [eq(providers.status, "ACTIVE")];
    if (providerType) conditions.push(eq(providers.providerType, providerType));
    if (city) conditions.push(ilike(providers.city, city));
    const where = and(...conditions);

    const [rows, totalResult] = await Promise.all([
      db.query.providers.findMany({
        where,
        orderBy: (p, { desc }) => [desc(p.createdAt)],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      db.select({ count: sql<number>`count(*)::int` }).from(providers).where(where),
    ]);

    const aggregates = await getReviewAggregates(db, rows.map((p) => p.id));
    return c.json(
      {
        providers: rows.map((p) => toPublicProvider(p, false, aggregates.get(p.id) ?? { averageRating: null, reviewCount: 0 })),
        page,
        pageSize,
        total: totalResult[0]?.count ?? 0,
      },
      200,
    );
  });

  app.post("/", requireAuth, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = createProviderSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    const user = c.get("user");
    // ownerUserId is never read from the request body — createProviderSchema
    // has no such field — and every new provider starts ACTIVE; status is
    // likewise absent from this schema, so neither can be client-supplied.
    const [inserted] = await db
      .insert(providers)
      .values({ ...parsed.data, ownerUserId: user.id })
      .returning();

    // A brand-new provider has no bookings yet, so it structurally cannot
    // have any reviews — no query needed to know the aggregate is empty.
    return c.json({ provider: toPublicProvider(inserted, true, { averageRating: null, reviewCount: 0 }) }, 201);
  });

  app.get("/:id", async (c) => {
    const idResult = providerIdSchema.safeParse(c.req.param("id"));
    if (!idResult.success) {
      return c.json({ error: "Invalid provider id" }, 400);
    }

    const provider = await db.query.providers.findFirst({ where: eq(providers.id, idResult.data) });
    if (!provider) {
      return c.json(NOT_FOUND, 404);
    }

    const requester = await getRequester(c);
    const isOwnerOrAdmin = requester !== null && (requester.id === provider.ownerUserId || requester.role === "ADMIN");

    if (provider.status !== "ACTIVE" && !isOwnerOrAdmin) {
      return c.json(NOT_FOUND, 404);
    }

    const aggregate = await getReviewAggregate(db, provider.id);
    return c.json({ provider: toPublicProvider(provider, isOwnerOrAdmin, aggregate) }, 200);
  });

  app.patch("/:id", requireAuth, async (c) => {
    const idResult = providerIdSchema.safeParse(c.req.param("id"));
    if (!idResult.success) {
      return c.json({ error: "Invalid provider id" }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const user = c.get("user");
    // An admin's request body must be validated against a schema that
    // actually accepts SUSPENDED, or it would be rejected as invalid
    // input here before assertStatusTransitionAllowed ever runs below.
    const schema = user.role === "ADMIN" ? adminUpdateProviderSchema : updateProviderSchema;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }
    if (Object.keys(parsed.data).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const existing = await db.query.providers.findFirst({ where: eq(providers.id, idResult.data) });
    if (!existing) {
      return c.json(NOT_FOUND, 404);
    }
    if (existing.ownerUserId !== user.id && user.role !== "ADMIN") {
      return c.json(NOT_FOUND, 404);
    }

    if (parsed.data.status) {
      try {
        assertStatusTransitionAllowed(existing.status, parsed.data.status, user.role);
      } catch (err) {
        if (err instanceof StatusTransitionError) {
          return c.json({ error: err.message }, 403);
        }
        throw err;
      }
    }

    const [updated] = await db
      .update(providers)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(providers.id, idResult.data))
      .returning();

    const patchAggregate = await getReviewAggregate(db, updated.id);
    return c.json({ provider: toPublicProvider(updated, true, patchAggregate) }, 200);
  });

  // Soft delete: sets status to INACTIVE rather than removing the row.
  // Providers will be referenced by future services/availability/bookings,
  // and a hard delete would either orphan or force a destructive cascade
  // through that historical data — deactivation keeps the row (and its
  // history) intact while removing it from public discovery.
  app.delete("/:id", requireAuth, async (c) => {
    const idResult = providerIdSchema.safeParse(c.req.param("id"));
    if (!idResult.success) {
      return c.json({ error: "Invalid provider id" }, 400);
    }

    const user = c.get("user");
    const existing = await db.query.providers.findFirst({ where: eq(providers.id, idResult.data) });
    if (!existing) {
      return c.json(NOT_FOUND, 404);
    }
    if (existing.ownerUserId !== user.id && user.role !== "ADMIN") {
      return c.json(NOT_FOUND, 404);
    }

    try {
      assertStatusTransitionAllowed(existing.status, "INACTIVE", user.role);
    } catch (err) {
      if (err instanceof StatusTransitionError) {
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }

    const [updated] = await db
      .update(providers)
      .set({ status: "INACTIVE", updatedAt: new Date() })
      .where(eq(providers.id, idResult.data))
      .returning();

    const deleteAggregate = await getReviewAggregate(db, updated.id);
    return c.json({ success: true, provider: toPublicProvider(updated, true, deleteAggregate) }, 200);
  });

  return app;
}
