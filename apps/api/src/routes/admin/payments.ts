import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { adminPaymentListQuerySchema } from "@pawlink/shared";
import type { AppEnv } from "../../types.js";
import type { DbClient } from "../../db/client.js";
import { payments } from "../../db/schema.js";
import { toAdminPayment } from "../../lib/admin.js";
import { createRequireAdmin } from "../../middleware/auth.js";

const uuidSchema = z.string().uuid();
const PAYMENT_NOT_FOUND = { error: "Payment not found" } as const;

// GET /api/admin/payments — read-only operational visibility. There is
// deliberately NO endpoint to set a payment's status here (see the
// milestone brief, "Payment mutation restrictions") — payment state
// comes exclusively from the existing payment-provider/webhook flow
// (routes/payments.ts); an admin dashboard must never be able to bypass
// that state machine, even for a well-intentioned manual correction.
export function createAdminPaymentRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  app.use("*", createRequireAdmin(db, nodeEnv));

  app.get("/", async (c) => {
    const parsedQuery = adminPaymentListQuerySchema.safeParse({
      status: c.req.query("status") || undefined,
      bookingId: c.req.query("bookingId") || undefined,
      page: c.req.query("page") ?? undefined,
      pageSize: c.req.query("pageSize") ?? undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: "Invalid query", fields: parsedQuery.error.flatten().fieldErrors }, 400);
    }
    const { status, bookingId, page, pageSize } = parsedQuery.data;

    const conditions = [];
    if (status) conditions.push(eq(payments.status, status));
    if (bookingId) conditions.push(eq(payments.bookingId, bookingId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalResult] = await Promise.all([
      db.query.payments.findMany({
        where,
        orderBy: (p, { desc }) => [desc(p.createdAt)],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      db.select({ count: sql<number>`count(*)::int` }).from(payments).where(where),
    ]);

    return c.json(
      { payments: rows.map(toAdminPayment), page, pageSize, total: totalResult[0]?.count ?? 0 },
      200,
    );
  });

  app.get("/:id", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid payment id" }, 400);

    const payment = await db.query.payments.findFirst({ where: eq(payments.id, idResult.data) });
    if (!payment) return c.json(PAYMENT_NOT_FOUND, 404);

    return c.json({ payment: toAdminPayment(payment) }, 200);
  });

  return app;
}
