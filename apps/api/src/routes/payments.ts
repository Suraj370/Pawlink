import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createPaymentSchema } from "@pawlink/shared";
import type { AppEnv } from "../types.js";
import type { DbClient } from "../db/client.js";
import { bookings, paymentIdempotencyKeys, paymentWebhookEvents, payments, providers } from "../db/schema.js";
import { assertBookingStatusTransition, BookingRouteError, BookingStatusTransitionError } from "../lib/booking.js";
import {
  canTransitionPaymentStatus,
  hashPaymentRequest,
  PaymentIdempotencyConflictError,
  PaymentIdempotencyRaceError,
  PaymentRouteError,
  toPublicPayment,
} from "../lib/payment.js";
import {
  MockPaymentProvider,
  PaymentWebhookPayloadError,
  PaymentWebhookSignatureError,
  type PaymentProvider,
  type PaymentProviderStatus,
} from "../lib/payment-provider.js";
import { createRequireAuth } from "../middleware/auth.js";

const uuidSchema = z.string().uuid();
const BOOKING_NOT_FOUND = { error: "Booking not found" } as const;
const PAYMENT_NOT_FOUND = { error: "Payment not found" } as const;
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type BookingRow = typeof bookings.$inferSelect;

// -------------------------------------------------------------------------
// POST /api/bookings/:bookingId/payment and GET /api/bookings/:bookingId/payment
// -------------------------------------------------------------------------
export function createBookingPaymentRoutes(db: DbClient, nodeEnv: string, provider: PaymentProvider) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);
  app.use("*", requireAuth);

  // -----------------------------------------------------------------------
  // POST / — create (or safely reuse) a payment attempt for this booking.
  //
  // Same core invariant as booking creation: every authoritative check
  // (ownership, payability, amount/currency) happens on a FRESH,
  // FOR-UPDATE-locked read of the booking inside this transaction — never
  // on a value read before the transaction opened. The amount is always
  // derived from the locked booking row; the client cannot supply it.
  // -----------------------------------------------------------------------
  app.post("/", async (c) => {
    const user = c.get("user");
    const bookingIdResult = uuidSchema.safeParse(c.req.param("bookingId"));
    if (!bookingIdResult.success) return c.json({ error: "Invalid booking id" }, 400);
    const bookingId = bookingIdResult.data;

    // Every field this endpoint accepts is optional (scenario only), so
    // an empty body is legitimate — but a genuinely malformed, non-empty
    // body must still be rejected rather than silently treated as "no
    // input", matching every other endpoint's malformed-JSON handling.
    const rawText = await c.req.text();
    let body: unknown = {};
    if (rawText.trim().length > 0) {
      try {
        body = JSON.parse(rawText);
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
    }
    const parsed = createPaymentSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }
    const scenario = parsed.data.scenario ?? "SUCCESS";
    const idempotencyKey = c.req.header("Idempotency-Key");
    const requestHash = idempotencyKey ? hashPaymentRequest(bookingId) : null;

    try {
      const result = await db.transaction(async (tx) => {
        // --- Authoritative read: lock the booking, verify ownership and payability ---
        const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
        if (!booking) throw new BookingRouteError(404, BOOKING_NOT_FOUND);
        // Only the booking's own customer may pay for it — provider
        // owners initiating payment on a customer's behalf is explicitly
        // out of scope for this milestone. Same IDOR-hiding convention
        // as everywhere else: 404, not 403.
        if (booking.customerUserId !== user.id) {
          throw new BookingRouteError(404, BOOKING_NOT_FOUND);
        }

        // --- Idempotency pre-check (BEFORE the payability gate) ---
        // Deliberately checked before the booking.status === "PENDING"
        // gate below, mirroring bookings' own sequential-replay fix
        // exactly (see routes/bookings.ts): a legitimate replay of a
        // request that already succeeded must return the SAME payment,
        // even though the booking's status has since correctly moved on
        // to CONFIRMED as a result of that very operation — it must not
        // be rejected by a payability check that only makes sense for a
        // genuinely NEW attempt.
        if (idempotencyKey) {
          const existingClaim = await tx.query.paymentIdempotencyKeys.findFirst({
            where: and(eq(paymentIdempotencyKeys.customerUserId, user.id), eq(paymentIdempotencyKeys.key, idempotencyKey)),
          });
          if (existingClaim && existingClaim.paymentId !== null) {
            if (existingClaim.requestHash !== requestHash) {
              throw new PaymentIdempotencyConflictError();
            }
            const existingPayment = await tx.query.payments.findFirst({ where: eq(payments.id, existingClaim.paymentId) });
            if (existingPayment) {
              return { payment: existingPayment, created: false };
            }
          }
        }

        if (booking.status !== "PENDING") {
          throw new BookingRouteError(409, { error: `This booking is not payable (status: ${booking.status})` });
        }

        // --- Duplicate payment protection ---
        // A booking may have many historical payment ATTEMPTS, but a
        // customer must never be able to create a second successful
        // payment, and retrying while one is already in flight must not
        // spawn a second concurrent attempt — return the existing one
        // instead of creating a new row.
        const [existingForBooking] = await tx
          .select()
          .from(payments)
          .where(eq(payments.bookingId, bookingId))
          .orderBy(desc(payments.createdAt))
          .limit(1);
        if (existingForBooking && (existingForBooking.status === "SUCCEEDED" || existingForBooking.status === "PENDING")) {
          return { payment: existingForBooking, created: false };
        }

        // --- Amount integrity: derived from the LOCKED booking row, never the client ---
        const amountMinor = booking.priceMinor;
        const currency = booking.currency;
        const paymentId = randomUUID();

        if (idempotencyKey) {
          const [claimed] = await tx
            .insert(paymentIdempotencyKeys)
            .values({ customerUserId: user.id, key: idempotencyKey, requestHash: requestHash!, paymentId: null })
            .onConflictDoNothing()
            .returning();
          if (!claimed) {
            const existing = await tx.query.paymentIdempotencyKeys.findFirst({
              where: and(eq(paymentIdempotencyKeys.customerUserId, user.id), eq(paymentIdempotencyKeys.key, idempotencyKey)),
            });
            if (!existing || existing.paymentId === null) {
              throw new PaymentIdempotencyRaceError();
            }
            if (existing.requestHash !== requestHash) {
              throw new PaymentIdempotencyConflictError();
            }
            const existingPayment = await tx.query.payments.findFirst({ where: eq(payments.id, existing.paymentId) });
            if (!existingPayment) throw new PaymentIdempotencyRaceError();
            return { payment: existingPayment, created: false };
          }
        }

        // --- Call the provider abstraction, never anything mock-specific ---
        const providerResult = await provider.createPayment({ paymentId, bookingId, amountMinor, currency, scenario });

        const [inserted] = await tx
          .insert(payments)
          .values({
            id: paymentId,
            bookingId,
            provider: provider.name,
            providerPaymentId: providerResult.providerPaymentId,
            amountMinor,
            currency,
            status: providerResult.status,
            failureCode: providerResult.failureCode ?? null,
            failureMessage: providerResult.failureMessage ?? null,
          })
          .returning();

        await applyBookingSideEffect(tx, booking, providerResult.status);

        if (idempotencyKey) {
          await tx
            .update(paymentIdempotencyKeys)
            .set({ paymentId: inserted.id })
            .where(and(eq(paymentIdempotencyKeys.customerUserId, user.id), eq(paymentIdempotencyKeys.key, idempotencyKey)));
        }

        return { payment: inserted, created: true };
      });

      return c.json({ payment: toPublicPayment(result.payment) }, result.created ? 201 : 200);
    } catch (err) {
      if (err instanceof BookingRouteError) return c.json(err.body, err.status);
      if (err instanceof PaymentIdempotencyConflictError) {
        return c.json({ error: "Idempotency-Key was already used with different payment parameters" }, 409);
      }
      if (err instanceof PaymentIdempotencyRaceError) {
        return c.json({ error: "Another request with the same Idempotency-Key is in progress; please retry" }, 409);
      }
      throw err;
    }
  });

  // GET / — the latest payment attempt for this booking, for the
  // customer's own payment-status UI. Same ownership rule as POST.
  app.get("/", async (c) => {
    const user = c.get("user");
    const bookingIdResult = uuidSchema.safeParse(c.req.param("bookingId"));
    if (!bookingIdResult.success) return c.json({ error: "Invalid booking id" }, 400);

    const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingIdResult.data) });
    if (!booking) return c.json(BOOKING_NOT_FOUND, 404);
    if (booking.customerUserId !== user.id) return c.json(BOOKING_NOT_FOUND, 404);

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.bookingId, bookingIdResult.data))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    if (!payment) return c.json({ payment: null }, 200);
    return c.json({ payment: toPublicPayment(payment) }, 200);
  });

  return app;
}

// -------------------------------------------------------------------------
// /api/payments — webhook + payment detail lookup
// -------------------------------------------------------------------------
export function createPaymentRoutes(db: DbClient, nodeEnv: string, provider: PaymentProvider) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);

  // -----------------------------------------------------------------------
  // POST /webhook — receives provider events. Deliberately NOT behind
  // requireAuth: a real payment provider is not an authenticated PawLink
  // user and cannot present a session cookie. Authenticity is established
  // entirely by the signature check below — "never trust an unsigned
  // webhook" applies even to this mock implementation.
  // -----------------------------------------------------------------------
  app.post("/webhook", async (c) => {
    const rawBody = await c.req.text();
    if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
      return c.json({ error: "Webhook payload too large" }, 413);
    }
    const signature = c.req.header("X-Mock-Signature");

    let event;
    try {
      event = provider.verifyWebhook(rawBody, signature);
    } catch (err) {
      if (err instanceof PaymentWebhookSignatureError) {
        return c.json({ error: "Invalid webhook signature" }, 401);
      }
      if (err instanceof PaymentWebhookPayloadError) {
        return c.json({ error: "Malformed webhook payload" }, 400);
      }
      throw err;
    }

    try {
      const result = await db.transaction(async (tx) => {
        // Webhook idempotency: INSERT ... ON CONFLICT DO NOTHING against
        // (provider, event_id) — the exact same Postgres row-lock-queuing
        // technique booking_idempotency_keys already relies on for
        // concurrent same-key requests, applied here to concurrent or
        // simply repeated webhook deliveries. If this is a replay, we're
        // done: no further action, no error.
        const [claimed] = await tx
          .insert(paymentWebhookEvents)
          .values({ provider: provider.name, eventId: event.eventId, paymentId: null })
          .onConflictDoNothing()
          .returning();
        if (!claimed) {
          return { applied: false, duplicate: true } as const;
        }

        const [payment] = await tx
          .select()
          .from(payments)
          .where(eq(payments.providerPaymentId, event.providerPaymentId))
          .for("update");
        if (!payment) {
          throw new PaymentRouteError(404, { error: "Unknown provider payment id" });
        }

        await tx.update(paymentWebhookEvents).set({ paymentId: payment.id }).where(eq(paymentWebhookEvents.eventId, event.eventId));

        // Out-of-order / duplicate-with-a-new-event-id / already-terminal
        // events all fail this same check — a single transition table is
        // the one place "is this event allowed to apply right now?" is
        // decided, not a scattered set of special cases. An invalid
        // transition is a safe, logged no-op: the event simply doesn't
        // apply, and we still return 200 (a webhook responder returning
        // an error code just causes the real provider to retry pointlessly).
        if (!canTransitionPaymentStatus(payment.status, event.status)) {
          return { applied: false, duplicate: false } as const;
        }

        await tx
          .update(payments)
          .set({
            status: event.status,
            failureCode: event.failureCode ?? null,
            failureMessage: event.failureMessage ?? null,
            updatedAt: new Date(),
          })
          .where(eq(payments.id, payment.id));

        const [booking] = await tx.select().from(bookings).where(eq(bookings.id, payment.bookingId)).for("update");
        if (booking) {
          await applyBookingSideEffect(tx, booking, event.status);
        }

        return { applied: true, duplicate: false } as const;
      });

      return c.json({ received: true, ...result }, 200);
    } catch (err) {
      if (err instanceof PaymentRouteError) return c.json(err.body, err.status);
      throw err;
    }
  });

  // GET /:id — payment detail. The payment's own customer, the owning
  // provider's owner, or an admin — mirroring GET /api/bookings/:id
  // exactly, including 404-not-403 for anyone else.
  app.get("/:id", requireAuth, async (c) => {
    const user = c.get("user");
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid payment id" }, 400);

    const payment = await db.query.payments.findFirst({ where: eq(payments.id, idResult.data) });
    if (!payment) return c.json(PAYMENT_NOT_FOUND, 404);

    const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, payment.bookingId) });
    if (!booking) return c.json(PAYMENT_NOT_FOUND, 404);

    const isCustomer = booking.customerUserId === user.id;
    let isProviderOwner = false;
    if (!isCustomer) {
      const bookingProvider = await db.query.providers.findFirst({ where: eq(providers.id, booking.providerId) });
      isProviderOwner = !!bookingProvider && (bookingProvider.ownerUserId === user.id || user.role === "ADMIN");
    }
    if (!isCustomer && !isProviderOwner) return c.json(PAYMENT_NOT_FOUND, 404);

    return c.json({ payment: toPublicPayment(payment) }, 200);
  });

  return app;
}

// -------------------------------------------------------------------------
// Shared transaction-boundary helper: applying a payment outcome to its
// booking. Used identically by the synchronous creation path (the mock
// provider resolves immediately for SUCCESS/FAILURE) and the webhook path
// (this IS the "BEGIN / lock payment / lock booking / verify current
// states / apply payment state transition / transition booking / COMMIT"
// flow the milestone specifies — expressed once, not duplicated per call
// site). Callers are responsible for having already locked `booking`
// with SELECT ... FOR UPDATE in the same transaction.
// -------------------------------------------------------------------------
async function applyBookingSideEffect(tx: Tx, booking: BookingRow, paymentStatus: PaymentProviderStatus): Promise<void> {
  if (paymentStatus === "SUCCEEDED") {
    try {
      assertBookingStatusTransition(booking.status, "CONFIRMED");
    } catch (err) {
      if (err instanceof BookingStatusTransitionError) {
        // The booking was independently cancelled (e.g. the customer
        // cancelled it directly) while this payment was in flight. The
        // payment itself still genuinely succeeded — a real system would
        // trigger a refund here, which is explicitly out of scope for
        // this milestone (see docs/architecture.md, "Known limitations").
        // The booking is deliberately NOT force-transitioned back to
        // CONFIRMED; this is a documented, intentional no-op.
        return;
      }
      throw err;
    }
    await tx.update(bookings).set({ status: "CONFIRMED", updatedAt: new Date() }).where(eq(bookings.id, booking.id));
    return;
  }
  if (paymentStatus === "FAILED") {
    try {
      assertBookingStatusTransition(booking.status, "CANCELLED");
    } catch (err) {
      if (err instanceof BookingStatusTransitionError) return; // already resolved some other way — safe no-op
      throw err;
    }
    await tx.update(bookings).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(bookings.id, booking.id));
  }
  // PENDING: no booking-side effect.
}

export function createMockPaymentProvider(webhookSecret: string): PaymentProvider {
  return new MockPaymentProvider(webhookSecret);
}
