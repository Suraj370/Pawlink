import { createHash } from "node:crypto";
import type { PaymentStatus, PublicPayment } from "@pawlink/shared";
import type { payments } from "../db/schema.js";

type PaymentRow = typeof payments.$inferSelect;

export function toPublicPayment(payment: PaymentRow): PublicPayment {
  return {
    id: payment.id,
    bookingId: payment.bookingId,
    provider: payment.provider,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    status: payment.status,
    failureCode: payment.failureCode,
    failureMessage: payment.failureMessage,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
    // providerPaymentId is deliberately NOT exposed — it's an
    // implementation-specific identifier, not something the customer
    // needs, and a future real provider's id format shouldn't leak into
    // the public API shape. Never expose internal provider credentials,
    // signatures, or raw webhook payloads either (see routes/payments.ts).
  };
}

export class PaymentStatusTransitionError extends Error {}

// Single authoritative transition table — no self-transitions (X -> X),
// mirroring assertBookingStatusTransition's own design exactly. A
// duplicate "succeeded" webhook for an already-SUCCEEDED payment is
// rejected here as an invalid transition, but that's never surfaced as a
// hard failure to the caller — see routes/payments.ts's webhook handler,
// which treats an invalid transition as a safe, logged no-op (the event
// simply doesn't apply), never a 4xx/5xx back to the provider. Genuine
// out-of-order events (e.g. payment.pending arriving after
// payment.succeeded already committed) are rejected the exact same way,
// by the exact same table — there is no separate "out-of-order" special
// case anywhere in this codebase.
const ALLOWED_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ["PENDING", "SUCCEEDED", "FAILED"],
  PENDING: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionPaymentStatus(current: PaymentStatus, next: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[current].includes(next);
}

export function assertPaymentStatusTransition(current: PaymentStatus, next: PaymentStatus): void {
  if (!canTransitionPaymentStatus(current, next)) {
    throw new PaymentStatusTransitionError(`Cannot transition a payment from ${current} to ${next}`);
  }
}

// Deterministic hash of the one thing a payment-creation request actually
// varies by: the booking it's for (amount/currency are derived from that
// booking server-side and can never differ for a fixed bookingId — see
// schema.ts's comment on payment_idempotency_keys). Mirrors
// hashBookingRequest's exact shape/rationale in lib/booking.ts.
export function hashPaymentRequest(bookingId: string): string {
  return createHash("sha256").update(JSON.stringify({ bookingId })).digest("hex");
}

export class PaymentIdempotencyConflictError extends Error {}
export class PaymentIdempotencyRaceError extends Error {}

// Carries a specific HTTP response out of a payment transaction, exactly
// like BookingRouteError in lib/booking.ts — thrown only for conditions
// discovered by the AUTHORITATIVE in-transaction reads, never a
// substitute for Zod input validation.
export class PaymentRouteError extends Error {
  constructor(
    public readonly status: 404 | 409,
    public readonly body: Record<string, unknown>,
  ) {
    super(`PaymentRouteError(${status})`);
  }
}
