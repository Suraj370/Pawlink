import { Hono } from "hono";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { adminBookingListQuerySchema } from "@pawlink/shared";
import type { AppEnv } from "../../types.js";
import type { DbClient } from "../../db/client.js";
import { bookings, payments } from "../../db/schema.js";
import { derivePaymentStatusForBooking, toAdminBookingSummary } from "../../lib/admin.js";
import { createRequireAdmin } from "../../middleware/auth.js";

const uuidSchema = z.string().uuid();
const BOOKING_NOT_FOUND = { error: "Booking not found" } as const;

// A hard cap on how many candidate rows the paymentStatus-filter path
// (see below) will ever pull into application memory at once — an
// admin-tool-scale safeguard, not a claim this scales to millions of
// bookings. See the comment on the paymentStatus branch for why this
// filter can't be pushed into the same single SQL query as the others.
const PAYMENT_STATUS_FILTER_CANDIDATE_CAP = 1000;

async function namesFor(db: DbClient, userIds: string[], providerIds: string[]) {
  const [userRows, providerRows] = await Promise.all([
    userIds.length > 0 ? db.query.users.findMany({ where: (u, { inArray: ia }) => ia(u.id, [...new Set(userIds)]) }) : [],
    providerIds.length > 0
      ? db.query.providers.findMany({ where: (p, { inArray: ia }) => ia(p.id, [...new Set(providerIds)]) })
      : [],
  ]);
  return {
    userNameById: new Map(userRows.map((u) => [u.id, u.name])),
    providerNameById: new Map(providerRows.map((p) => [p.id, p.businessName])),
  };
}

// -----------------------------------------------------------------------
// /api/admin/bookings — operational visibility across EVERY customer and
// provider, read-only. No mutation endpoint exists here at all (see the
// milestone brief's "operational visibility does not automatically mean
// mutation permission") — bookings only ever change through the existing
// customer/provider-facing booking lifecycle endpoints.
// -----------------------------------------------------------------------
export function createAdminBookingRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  app.use("*", createRequireAdmin(db, nodeEnv));

  app.get("/", async (c) => {
    const parsedQuery = adminBookingListQuerySchema.safeParse({
      status: c.req.query("status") || undefined,
      providerId: c.req.query("providerId") || undefined,
      paymentStatus: c.req.query("paymentStatus") || undefined,
      dateFrom: c.req.query("dateFrom") || undefined,
      dateTo: c.req.query("dateTo") || undefined,
      page: c.req.query("page") ?? undefined,
      pageSize: c.req.query("pageSize") ?? undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: "Invalid query", fields: parsedQuery.error.flatten().fieldErrors }, 400);
    }
    const { status, providerId, paymentStatus, dateFrom, dateTo, page, pageSize } = parsedQuery.data;

    const conditions = [];
    if (status) conditions.push(eq(bookings.status, status));
    if (providerId) conditions.push(eq(bookings.providerId, providerId));
    if (dateFrom) conditions.push(gte(bookings.startAt, new Date(`${dateFrom}T00:00:00.000Z`)));
    if (dateTo) {
      const exclusiveEnd = new Date(`${dateTo}T00:00:00.000Z`);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      conditions.push(lt(bookings.startAt, exclusiveEnd));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    let pageRows: (typeof bookings.$inferSelect)[];
    let total: number;

    if (paymentStatus) {
      // paymentStatus is a DERIVED value (see lib/admin.ts's
      // derivePaymentStatusForBooking) computed from a booking's payment
      // ATTEMPT rows, not a column on `bookings` itself — it can't be
      // pushed into the same single indexed SQL query the other filters
      // use. Rather than a fragile hand-written correlated subquery,
      // this pulls the (status/provider/date-filtered) candidate set,
      // computes each one's derived status in application code, and
      // paginates the filtered result in memory — correct, but bounded
      // by PAYMENT_STATUS_FILTER_CANDIDATE_CAP; an admin tool at this
      // scale, not a claim this approach scales unbounded.
      const candidates = await db.query.bookings.findMany({
        where,
        orderBy: (b, { desc }) => [desc(b.createdAt)],
        limit: PAYMENT_STATUS_FILTER_CANDIDATE_CAP,
      });
      const candidatePayments =
        candidates.length > 0
          ? await db.query.payments.findMany({ where: inArray(payments.bookingId, candidates.map((b) => b.id)) })
          : [];
      const paymentsByBooking = new Map<string, (typeof payments.$inferSelect)[]>();
      for (const p of candidatePayments) {
        const list = paymentsByBooking.get(p.bookingId) ?? [];
        list.push(p);
        paymentsByBooking.set(p.bookingId, list);
      }
      const filtered = candidates.filter(
        (b) => derivePaymentStatusForBooking(paymentsByBooking.get(b.id) ?? []) === paymentStatus,
      );
      total = filtered.length;
      pageRows = filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
    } else {
      const [rows, totalResult] = await Promise.all([
        db.query.bookings.findMany({
          where,
          orderBy: (b, { desc }) => [desc(b.createdAt)],
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
        db.select({ count: sql<number>`count(*)::int` }).from(bookings).where(where),
      ]);
      pageRows = rows;
      total = totalResult[0]?.count ?? 0;
    }

    const pagePayments =
      pageRows.length > 0
        ? await db.query.payments.findMany({ where: inArray(payments.bookingId, pageRows.map((b) => b.id)) })
        : [];
    const paymentsByBooking = new Map<string, (typeof payments.$inferSelect)[]>();
    for (const p of pagePayments) {
      const list = paymentsByBooking.get(p.bookingId) ?? [];
      list.push(p);
      paymentsByBooking.set(p.bookingId, list);
    }

    const { userNameById, providerNameById } = await namesFor(
      db,
      pageRows.map((b) => b.customerUserId),
      pageRows.map((b) => b.providerId),
    );

    return c.json(
      {
        bookings: pageRows.map((b) =>
          toAdminBookingSummary(b, {
            customerName: userNameById.get(b.customerUserId) ?? "Unknown",
            providerName: providerNameById.get(b.providerId) ?? "Unknown",
            paymentStatus: derivePaymentStatusForBooking(paymentsByBooking.get(b.id) ?? []),
          }),
        ),
        page,
        pageSize,
        total,
      },
      200,
    );
  });

  app.get("/:id", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid booking id" }, 400);

    const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, idResult.data) });
    if (!booking) return c.json(BOOKING_NOT_FOUND, 404);

    const [bookingPayments, { userNameById, providerNameById }] = await Promise.all([
      db.query.payments.findMany({ where: eq(payments.bookingId, booking.id) }),
      namesFor(db, [booking.customerUserId], [booking.providerId]),
    ]);

    return c.json(
      {
        booking: toAdminBookingSummary(booking, {
          customerName: userNameById.get(booking.customerUserId) ?? "Unknown",
          providerName: providerNameById.get(booking.providerId) ?? "Unknown",
          paymentStatus: derivePaymentStatusForBooking(bookingPayments),
        }),
      },
      200,
    );
  });

  return app;
}
