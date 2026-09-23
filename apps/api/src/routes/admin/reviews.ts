import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { adminReviewListQuerySchema } from "@pawlink/shared";
import type { AppEnv } from "../../types.js";
import type { DbClient } from "../../db/client.js";
import { reviews, users } from "../../db/schema.js";
import { toPublicReview, toReviewerDisplayName } from "../../lib/review.js";
import { recordAuditEvent } from "../../lib/audit.js";
import { createRequireAdmin } from "../../middleware/auth.js";

const uuidSchema = z.string().uuid();
const REVIEW_NOT_FOUND = { error: "Review not found" } as const;

// -----------------------------------------------------------------------
// /api/admin/reviews — moderation. Unlike the public provider review
// list (which shows only PUBLISHED reviews), this sees every review
// regardless of status — an admin needs to find a HIDDEN one to
// republish it, or a PUBLISHED one to hide it. Only an admin may reach
// either action — never a provider (even the one being reviewed), never
// a customer, not even the reviewing customer themselves (their own
// PATCH /api/reviews/:id can edit content, never status — see
// routes/reviews.ts and docs/architecture.md).
// -----------------------------------------------------------------------
export function createAdminReviewRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  app.use("*", createRequireAdmin(db, nodeEnv));

  app.get("/", async (c) => {
    const parsedQuery = adminReviewListQuerySchema.safeParse({
      status: c.req.query("status") || undefined,
      providerId: c.req.query("providerId") || undefined,
      page: c.req.query("page") ?? undefined,
      pageSize: c.req.query("pageSize") ?? undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: "Invalid query", fields: parsedQuery.error.flatten().fieldErrors }, 400);
    }
    const { status, providerId, page, pageSize } = parsedQuery.data;

    const conditions = [];
    if (status) conditions.push(eq(reviews.status, status));
    if (providerId) conditions.push(eq(reviews.providerId, providerId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalResult] = await Promise.all([
      db.query.reviews.findMany({
        where,
        orderBy: (r, { desc }) => [desc(r.createdAt)],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      db.select({ count: sql<number>`count(*)::int` }).from(reviews).where(where),
    ]);

    const reviewerIds = [...new Set(rows.map((r) => r.customerUserId))];
    const reviewers =
      reviewerIds.length > 0 ? await db.query.users.findMany({ where: inArray(users.id, reviewerIds) }) : [];
    const nameById = new Map(reviewers.map((u) => [u.id, u.name]));

    return c.json(
      {
        reviews: rows.map((r) => toPublicReview(r, toReviewerDisplayName(nameById.get(r.customerUserId) ?? ""))),
        page,
        pageSize,
        total: totalResult[0]?.count ?? 0,
      },
      200,
    );
  });

  async function moderate(reviewId: string, targetStatus: "PUBLISHED" | "HIDDEN", actorUserId: string) {
    return db.transaction(async (tx) => {
      const [review] = await tx.select().from(reviews).where(eq(reviews.id, reviewId)).for("update");
      if (!review) return { error: "not_found" as const };
      if (review.status === targetStatus) return { error: "no_change" as const };

      const [updated] = await tx
        .update(reviews)
        .set({ status: targetStatus, updatedAt: new Date() })
        .where(eq(reviews.id, reviewId))
        .returning();

      await recordAuditEvent(tx, {
        actorUserId,
        action: targetStatus === "HIDDEN" ? "ADMIN_REVIEW_HIDDEN" : "ADMIN_REVIEW_PUBLISHED",
        resourceType: "review",
        resourceId: review.id,
        providerId: review.providerId,
        // Never the review's actual title/comment — only which provider
        // it belongs to, matching every other audit event in this
        // codebase's "structural context only" rule.
        metadata: { previousStatus: review.status },
      });

      return { review: updated };
    });
  }

  app.post("/:id/hide", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid review id" }, 400);

    const user = c.get("user");
    const result = await moderate(idResult.data, "HIDDEN", user.id);
    if ("error" in result) {
      if (result.error === "not_found") return c.json(REVIEW_NOT_FOUND, 404);
      return c.json({ error: "This review is already hidden" }, 409);
    }

    const reviewer = await db.query.users.findFirst({ where: eq(users.id, result.review.customerUserId) });
    return c.json({ review: toPublicReview(result.review, toReviewerDisplayName(reviewer?.name ?? "")) }, 200);
  });

  app.post("/:id/publish", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid review id" }, 400);

    const user = c.get("user");
    const result = await moderate(idResult.data, "PUBLISHED", user.id);
    if ("error" in result) {
      if (result.error === "not_found") return c.json(REVIEW_NOT_FOUND, 404);
      return c.json({ error: "This review is already published" }, 409);
    }

    const reviewer = await db.query.users.findFirst({ where: eq(users.id, result.review.customerUserId) });
    return c.json({ review: toPublicReview(result.review, toReviewerDisplayName(reviewer?.name ?? "")) }, 200);
  });

  return app;
}
