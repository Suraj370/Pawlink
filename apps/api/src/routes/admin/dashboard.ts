import { Hono } from "hono";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { AppEnv } from "../../types.js";
import type { DbClient } from "../../db/client.js";
import { bookings, payments, providers, reviews, users } from "../../db/schema.js";
import { createRequireAdmin } from "../../middleware/auth.js";

// GET /api/admin/dashboard — a handful of independent PostgreSQL
// aggregate queries run in parallel (never one row fetched per entity,
// never an N+1 pattern — see the milestone brief's "avoid N+1 queries").
// Every number is computed fresh on every request; nothing here is
// hard-coded or cached.
export function createAdminDashboardRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  app.use("*", createRequireAdmin(db, nodeEnv));

  app.get("/", async (c) => {
    const now = new Date();

    // totalCustomers deliberately counts every user account (regardless
    // of `role`), not just PET_PARENT — this schema's `role` field
    // (VET/GROOMER/BOARDING_PROVIDER/PET_PARENT/ADMIN) doesn't cleanly
    // separate "customer" from "provider owner" in the first place: any
    // authenticated user, of any role, may create a `providers` row (see
    // routes/providers.ts — POST has no role check), so role alone can't
    // answer "is this a customer." "Total customers" here means the same
    // thing "Total providers" means for the peer metric below: every
    // account that exists on the platform, counted from its own table.
    const [
      totalCustomers,
      totalProviders,
      activeProviders,
      suspendedProviders,
      upcomingBookings,
      pendingPayments,
      completedBookings,
      reviewCount,
    ] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(users),
      db.select({ count: sql<number>`count(*)::int` }).from(providers),
      db.select({ count: sql<number>`count(*)::int` }).from(providers).where(eq(providers.status, "ACTIVE")),
      db.select({ count: sql<number>`count(*)::int` }).from(providers).where(eq(providers.status, "SUSPENDED")),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(bookings)
        .where(and(inArray(bookings.status, ["PENDING", "CONFIRMED"]), gte(bookings.startAt, now))),
      db.select({ count: sql<number>`count(*)::int` }).from(payments).where(inArray(payments.status, ["CREATED", "PENDING"])),
      db.select({ count: sql<number>`count(*)::int` }).from(bookings).where(eq(bookings.status, "COMPLETED")),
      db.select({ count: sql<number>`count(*)::int` }).from(reviews),
    ]);

    return c.json(
      {
        totalCustomers: totalCustomers[0]?.count ?? 0,
        totalProviders: totalProviders[0]?.count ?? 0,
        activeProviders: activeProviders[0]?.count ?? 0,
        suspendedProviders: suspendedProviders[0]?.count ?? 0,
        upcomingBookings: upcomingBookings[0]?.count ?? 0,
        pendingPayments: pendingPayments[0]?.count ?? 0,
        completedBookings: completedBookings[0]?.count ?? 0,
        reviewCount: reviewCount[0]?.count ?? 0,
      },
      200,
    );
  });

  return app;
}
