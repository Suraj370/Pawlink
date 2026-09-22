import { z } from "zod";

// Lifecycle (documented decision — see docs/architecture.md, "Payment
// state machine"):
//
//   CREATED   -> PENDING | SUCCEEDED | FAILED
//   PENDING   -> SUCCEEDED | FAILED | CANCELLED
//   SUCCEEDED, FAILED, CANCELLED are terminal — no transitions out.
//
// CREATED exists as a distinct instant from PENDING (the row exists
// before the provider has been called at all) so a provider-call failure
// (network error, provider 500) has somewhere to leave the record rather
// than having no row at all — but the mock provider always responds
// synchronously, so in practice every payment created through today's API
// immediately becomes PENDING, SUCCEEDED, or FAILED within the same
// request; CREATED is never observed as a resting state through the API.
// No self-transitions (X -> X) are legal, mirroring bookingStatus's own
// transition table — a duplicate "succeeded" webhook for an
// already-SUCCEEDED payment is handled by webhook event-id idempotency
// (see payment_webhook_events), never by treating SUCCEEDED -> SUCCEEDED
// as an allowed state-machine transition.
export const PAYMENT_STATUS_VALUES = ["CREATED", "PENDING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export const paymentStatusSchema = z.enum(PAYMENT_STATUS_VALUES);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

// The deterministic mock provider's only three possible outcomes for a
// created payment — this field exists purely so development/tests can
// choose an outcome instead of relying on randomness ("the mock provider
// must be deterministic... tests must be reproducible"). It has no
// equivalent on a real payment provider and is clearly a mock-only
// concept — see apps/api/src/lib/payment-provider.ts.
export const PAYMENT_SCENARIO_VALUES = ["SUCCESS", "FAILURE", "PENDING"] as const;
export const paymentScenarioSchema = z.enum(PAYMENT_SCENARIO_VALUES);
export type PaymentScenario = z.infer<typeof paymentScenarioSchema>;

// Creation never accepts amountMinor, currency, customerUserId, status, or
// bookingId-derived pricing — every one of those is server-derived from
// the authoritative booking row (see routes/payments.ts). `scenario` is
// the one mock-only exception: it doesn't represent money, it just picks
// which deterministic outcome the LOCAL mock provider should simulate,
// and defaults to "SUCCESS" when omitted.
export const createPaymentSchema = z.object({
  scenario: paymentScenarioSchema.optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

// Never a raw database row — amountMinor/currency are what the customer
// actually owes for THIS booking (server-derived, immutable once the
// payment exists), never re-read from the booking at render time.
export const publicPaymentSchema = z.object({
  id: z.string(),
  bookingId: z.string(),
  provider: z.string(),
  amountMinor: z.number(),
  currency: z.string(),
  status: paymentStatusSchema,
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicPayment = z.infer<typeof publicPaymentSchema>;
