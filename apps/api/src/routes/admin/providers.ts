import { Hono } from "hono";
import { and, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import { adminProviderListQuerySchema, adminProviderStatusSchema } from "@pawlink/shared";
import type { AppEnv } from "../../types.js";
import type { DbClient } from "../../db/client.js";
import { providers } from "../../db/schema.js";
import { StatusTransitionError, assertStatusTransitionAllowed, toPublicProvider } from "../../lib/provider.js";
import { getReviewAggregate, getReviewAggregates } from "../../lib/review.js";
import { recordAuditEvent } from "../../lib/audit.js";
import { createRequireAdmin } from "../../middleware/auth.js";

const uuidSchema = z.string().uuid();
const PROVIDER_NOT_FOUND = { error: "Provider not found" } as const;

// -----------------------------------------------------------------------
// /api/admin/providers — operational provider management. Unlike public
// discovery (GET /api/providers), this sees EVERY provider regardless of
// status — an admin needs to find a SUSPENDED or INACTIVE listing to act
// on it, which is exactly what public discovery must never reveal.
// -----------------------------------------------------------------------
export function createAdminProviderRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  app.use("*", createRequireAdmin(db, nodeEnv));

  app.get("/", async (c) => {
    const parsedQuery = adminProviderListQuerySchema.safeParse({
      search: c.req.query("search") || undefined,
      status: c.req.query("status") || undefined,
      providerType: c.req.query("providerType") || undefined,
      page: c.req.query("page") ?? undefined,
      pageSize: c.req.query("pageSize") ?? undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: "Invalid query", fields: parsedQuery.error.flatten().fieldErrors }, 400);
    }
    const { search, status, providerType, page, pageSize } = parsedQuery.data;

    const conditions = [];
    // A parameterized ILIKE — the search term is always bound as a
    // value, never concatenated into SQL text, so it carries no
    // injection surface regardless of what characters it contains (see
    // the milestone brief's "do not concatenate SQL strings").
    if (search) conditions.push(ilike(providers.businessName, `%${search}%`));
    if (status) conditions.push(eq(providers.status, status));
    if (providerType) conditions.push(eq(providers.providerType, providerType));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

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
        providers: rows.map((p) => toPublicProvider(p, true, aggregates.get(p.id) ?? { averageRating: null, reviewCount: 0 })),
        page,
        pageSize,
        total: totalResult[0]?.count ?? 0,
      },
      200,
    );
  });

  app.get("/:id", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid provider id" }, 400);

    const provider = await db.query.providers.findFirst({ where: eq(providers.id, idResult.data) });
    if (!provider) return c.json(PROVIDER_NOT_FOUND, 404);

    const aggregate = await getReviewAggregate(db, provider.id);
    return c.json({ provider: toPublicProvider(provider, true, aggregate) }, 200);
  });

  // POST /:id/status — the ONE thing this endpoint does. Reuses the same
  // assertStatusTransitionAllowed table the owner-facing
  // PATCH /api/providers/:id already relies on (an admin actor is always
  // permitted every transition, including out of SUSPENDED — see
  // lib/provider.ts) — never a second, parallel transition rule. Wrapped
  // in a transaction with its own audit event: either both the status
  // change and the audit record land, or neither does (see the milestone
  // brief's "do not create: provider suspended but no audit record").
  app.post("/:id/status", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid provider id" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = adminProviderStatusSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    const user = c.get("user");

    try {
      const updated = await db.transaction(async (tx) => {
        const [provider] = await tx.select().from(providers).where(eq(providers.id, idResult.data)).for("update");
        if (!provider) {
          throw new AdminRouteError(404, PROVIDER_NOT_FOUND);
        }

        try {
          assertStatusTransitionAllowed(provider.status, parsed.data.status, user.role);
        } catch (err) {
          if (err instanceof StatusTransitionError) {
            throw new AdminRouteError(403, { error: err.message });
          }
          throw err;
        }

        const previousStatus = provider.status;
        const [row] = await tx
          .update(providers)
          .set({ status: parsed.data.status, updatedAt: new Date() })
          .where(eq(providers.id, idResult.data))
          .returning();

        await recordAuditEvent(tx, {
          actorUserId: user.id,
          action: "PROVIDER_STATUS_CHANGED",
          resourceType: "provider",
          resourceId: provider.id,
          providerId: provider.id,
          metadata: { previousStatus, newStatus: parsed.data.status },
        });

        return row;
      });

      const aggregate = await getReviewAggregate(db, updated.id);
      return c.json({ provider: toPublicProvider(updated, true, aggregate) }, 200);
    } catch (err) {
      if (err instanceof AdminRouteError) {
        return c.json(err.body, err.status);
      }
      throw err;
    }
  });

  return app;
}

class AdminRouteError extends Error {
  constructor(
    public readonly status: 403 | 404,
    public readonly body: Record<string, unknown>,
  ) {
    super(`AdminRouteError(${status})`);
  }
}
