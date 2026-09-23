import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createReviewSchema, reviewListQuerySchema, updateReviewSchema } from "@pawlink/shared";
import type { AppEnv } from "../types.js";
import type { DbClient } from "../db/client.js";
import { bookings, providers, reviews, users } from "../db/schema.js";
import { getReviewAggregate, toPublicReview, toReviewerDisplayName } from "../lib/review.js";
import { createRequireAuth } from "../middleware/auth.js";

const uuidSchema = z.string().uuid();

// Same information-hiding convention as bookings/medical-records: an id
// that's syntactically valid but doesn't resolve to something the caller
// may see/act on returns 404, identically to a nonexistent one.
const BOOKING_NOT_FOUND = { error: "Booking not found" } as const;
const REVIEW_NOT_FOUND = { error: "Review not found" } as const;
const PROVIDER_NOT_FOUND = { error: "Provider not found" } as const;

const UNIQUE_VIOLATION = "23505";
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === UNIQUE_VIOLATION;
}

async function isProviderOwnerOfBooking(
  db: Pick<DbClient, "query">,
  booking: { providerId: string },
  userId: string,
  userRole: string,
) {
  const provider = await db.query.providers.findFirst({ where: eq(providers.id, booking.providerId) });
  return !!provider && (provider.ownerUserId === userId || userRole === "ADMIN");
}

// -----------------------------------------------------------------------
// Booking-scoped routes: GET/POST /api/bookings/:bookingId/review
// -----------------------------------------------------------------------
export function createBookingReviewRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);
  app.use("*", requireAuth);

  async function loadBooking(c: Context<AppEnv>) {
    const idResult = uuidSchema.safeParse(c.req.param("bookingId"));
    if (!idResult.success) return { error: c.json({ error: "Invalid booking id" }, 400) } as const;
    const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, idResult.data) });
    if (!booking) return { error: c.json(BOOKING_NOT_FOUND, 404) } as const;
    return { booking } as const;
  }

  // GET / — the booking's own customer (to see/edit their review) or the
  // owning provider (to see it without going through the public list).
  app.get("/", async (c) => {
    const loaded = await loadBooking(c);
    if ("error" in loaded) return loaded.error;
    const { booking } = loaded;
    const user = c.get("user");

    const isCustomer = booking.customerUserId === user.id;
    const isProviderOwner = isCustomer ? false : await isProviderOwnerOfBooking(db, booking, user.id, user.role);
    if (!isCustomer && !isProviderOwner) {
      return c.json(BOOKING_NOT_FOUND, 404);
    }

    const review = await db.query.reviews.findFirst({ where: eq(reviews.bookingId, booking.id) });
    if (!review) return c.json(REVIEW_NOT_FOUND, 404);

    const displayName = isCustomer
      ? toReviewerDisplayName(user.name)
      : toReviewerDisplayName((await db.query.users.findFirst({ where: eq(users.id, review.customerUserId) }))?.name ?? "");

    return c.json({ review: toPublicReview(review, displayName) }, 200);
  });

  // -----------------------------------------------------------------------
  // POST / — create a review. Core invariant: a review may only be created
  // by the booking's own customer, for a booking that has actually reached
  // COMPLETED, and at most once per booking — enforced by BOTH an
  // application-level check (a clear error message) AND the database's own
  // UNIQUE(booking_id) constraint (the actual correctness guarantee under
  // concurrency — see the migration and docs/architecture.md).
  //
  // providerId and customerUserId are never read from the request body —
  // createReviewSchema has no such fields. providerId comes solely from
  // the booking row (booking.providerId), customerUserId solely from the
  // session — a client cannot make a review point at any provider/customer
  // other than the ones the booking itself actually involved.
  // -----------------------------------------------------------------------
  app.post("/", async (c) => {
    const loaded = await loadBooking(c);
    if ("error" in loaded) return loaded.error;
    const { booking } = loaded;
    const user = c.get("user");

    if (booking.customerUserId !== user.id) {
      // A provider attempting to review their own booking already knows
      // it exists — 403 leaks nothing new. Anyone else gets the same 404
      // a nonexistent booking would.
      if (await isProviderOwnerOfBooking(db, booking, user.id, user.role)) {
        return c.json({ error: "Only the customer may review this booking" }, 403);
      }
      return c.json(BOOKING_NOT_FOUND, 404);
    }

    if (booking.status !== "COMPLETED") {
      return c.json({ error: "Only completed bookings can be reviewed" }, 409);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = createReviewSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    try {
      const [inserted] = await db
        .insert(reviews)
        .values({
          bookingId: booking.id,
          customerUserId: user.id,
          providerId: booking.providerId,
          rating: parsed.data.rating,
          title: parsed.data.title ?? null,
          comment: parsed.data.comment ?? null,
        })
        .returning();

      return c.json({ review: toPublicReview(inserted, toReviewerDisplayName(user.name)) }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // The database is the final authority: even after the read above,
        // a genuinely concurrent second request could have already
        // claimed this booking's one-and-only review row.
        return c.json({ error: "This booking has already been reviewed" }, 409);
      }
      throw err;
    }
  });

  return app;
}

// -----------------------------------------------------------------------
// Review-scoped routes: PATCH /api/reviews/:id
// -----------------------------------------------------------------------
export function createReviewRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);
  app.use("*", requireAuth);

  // Only the authoring customer may amend their own review — never a
  // provider (even the reviewed one), never another customer, and (a
  // deliberate scope decision — see the milestone brief's "do not add
  // complicated admin workflows yet") not even an admin. booking_id/
  // customer_user_id/provider_id/created_at are never part of
  // updateReviewSchema at all, so they're structurally unwritable here.
  app.patch("/:id", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid review id" }, 400);

    const user = c.get("user");
    const review = await db.query.reviews.findFirst({ where: eq(reviews.id, idResult.data) });
    if (!review || review.customerUserId !== user.id) {
      return c.json(REVIEW_NOT_FOUND, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = updateReviewSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }
    if (Object.keys(parsed.data).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const [updated] = await db
      .update(reviews)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(reviews.id, idResult.data))
      .returning();

    return c.json({ review: toPublicReview(updated, toReviewerDisplayName(user.name)) }, 200);
  });

  return app;
}

// -----------------------------------------------------------------------
// Provider-scoped route: GET /api/providers/:providerId/reviews (public)
// -----------------------------------------------------------------------
export function createProviderReviewRoutes(db: DbClient) {
  const app = new Hono<AppEnv>();

  // Public, no auth required — reviews are visible to anyone, same as
  // provider discovery itself. Deliberately NOT gated on the provider's
  // current status (ACTIVE/INACTIVE/SUSPENDED), unlike services/
  // availability: a review is a historical record of service already
  // received, and stays visible even if the provider later deactivates —
  // see docs/architecture.md, "Reviews & ratings."
  app.get("/", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("providerId"));
    if (!idResult.success) return c.json({ error: "Invalid provider id" }, 400);

    const provider = await db.query.providers.findFirst({ where: eq(providers.id, idResult.data) });
    if (!provider) return c.json(PROVIDER_NOT_FOUND, 404);

    const parsedQuery = reviewListQuerySchema.safeParse({
      page: c.req.query("page") ?? undefined,
      pageSize: c.req.query("pageSize") ?? undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: "Invalid query", fields: parsedQuery.error.flatten().fieldErrors }, 400);
    }
    const { page, pageSize } = parsedQuery.data;

    const where = and(eq(reviews.providerId, provider.id), eq(reviews.status, "PUBLISHED"));
    const [rows, aggregate] = await Promise.all([
      db.query.reviews.findMany({
        where,
        orderBy: (r, { desc }) => [desc(r.createdAt)],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      getReviewAggregate(db, provider.id),
    ]);

    const reviewerIds = [...new Set(rows.map((r) => r.customerUserId))];
    const reviewers =
      reviewerIds.length > 0 ? await db.query.users.findMany({ where: (u, { inArray }) => inArray(u.id, reviewerIds) }) : [];
    const nameById = new Map(reviewers.map((u) => [u.id, u.name]));

    return c.json(
      {
        reviews: rows.map((r) => toPublicReview(r, toReviewerDisplayName(nameById.get(r.customerUserId) ?? ""))),
        page,
        pageSize,
        // aggregate.reviewCount and this list's total are the same
        // number by construction (both count PUBLISHED reviews for this
        // provider) — reusing it here avoids a second COUNT(*) query.
        total: aggregate.reviewCount,
        aggregate,
      },
      200,
    );
  });

  return app;
}
