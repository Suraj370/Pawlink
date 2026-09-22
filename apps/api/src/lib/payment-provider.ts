import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentScenario } from "@pawlink/shared";

// ---------------------------------------------------------------------
// The architectural boundary this milestone exists to establish:
//
//   Booking/Payment domain
//           ↓
//   PaymentProvider interface   <- everything below this line
//           ↓
//   MockPaymentProvider          <- the one concrete implementation today
//
// routes/payments.ts (and lib/payment.ts) talk ONLY to the
// PaymentProvider interface — never to anything mock-specific. A future
// real provider (Stripe/Razorpay/etc.) implements the same three
// methods and gets swapped in at the composition root (app.ts) with no
// change to the booking/payment domain logic at all. No real payment
// credentials, bank integrations, or money transfers exist anywhere in
// this codebase — this is a deterministic, local, clearly-labeled
// development/test double for an eventual real provider.
// ---------------------------------------------------------------------

export type PaymentProviderStatus = "PENDING" | "SUCCEEDED" | "FAILED";

export type PaymentProviderResult = {
  providerPaymentId: string;
  status: PaymentProviderStatus;
  failureCode?: string;
  failureMessage?: string;
};

export type CreatePaymentProviderInput = {
  // Our OWN payment row's id, passed through so a provider can echo it
  // back in webhook payloads (a real provider would instead be given an
  // idempotency key / metadata field for this same purpose).
  paymentId: string;
  bookingId: string;
  amountMinor: number;
  currency: string;
  // Mock-only: see packages/shared/src/payments.ts. A real provider's
  // interface implementation would ignore or never receive this field.
  scenario: PaymentScenario;
};

export type PaymentWebhookEventType = "payment.succeeded" | "payment.failed" | "payment.pending";

export type PaymentWebhookEvent = {
  eventId: string;
  type: PaymentWebhookEventType;
  providerPaymentId: string;
  status: PaymentProviderStatus;
  failureCode?: string;
  failureMessage?: string;
};

export class PaymentWebhookSignatureError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
  }
}

export class PaymentWebhookPayloadError extends Error {
  constructor(message = "Malformed webhook payload") {
    super(message);
  }
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentProviderInput): Promise<PaymentProviderResult>;
  getPayment(providerPaymentId: string): Promise<PaymentProviderResult>;
  // Throws PaymentWebhookSignatureError / PaymentWebhookPayloadError
  // rather than returning null/undefined — an unverifiable webhook is
  // never silently ignored, it's an error condition the caller must
  // handle explicitly (see routes/payments.ts).
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): PaymentWebhookEvent;
}

const MOCK_PROVIDER_NAME = "mock";

// Exported (not just a private helper) so tests can sign a deliberately
// malformed or otherwise adversarial body exactly the way a real webhook
// delivery would — e.g. to prove that a well-signed-but-unparseable
// payload is rejected for being malformed, not for having a bad
// signature. buildMockWebhookRequest below covers the common "well-formed
// event" case; this is for constructing arbitrary raw bodies.
export function sign(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch rather than returning
  // false — an attacker-controlled signature header must never crash
  // the request, so length is checked first.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Deterministic, stateless mock: the provider-side payment id ENCODES the
// scenario it was created with (`mock_<scenario>_<paymentId>`), so
// getPayment() can report a consistent status purely by decoding the id
// it was given — no in-memory map, no database of its own, nothing that
// wouldn't survive a process restart (there's nothing TO survive; it's
// pure). "Do not use random payment outcomes" is satisfied trivially:
// there is no randomness anywhere in this class.
export class MockPaymentProvider implements PaymentProvider {
  readonly name = MOCK_PROVIDER_NAME;

  constructor(private readonly webhookSecret: string) {}

  async createPayment(input: CreatePaymentProviderInput): Promise<PaymentProviderResult> {
    const providerPaymentId = `mock_${input.scenario.toLowerCase()}_${input.paymentId}`;
    if (input.scenario === "PENDING") {
      return { providerPaymentId, status: "PENDING" };
    }
    if (input.scenario === "FAILURE") {
      return {
        providerPaymentId,
        status: "FAILED",
        failureCode: "mock_declined",
        failureMessage: "The mock payment provider declined this payment (scenario=FAILURE).",
      };
    }
    return { providerPaymentId, status: "SUCCEEDED" };
  }

  async getPayment(providerPaymentId: string): Promise<PaymentProviderResult> {
    const scenario = decodeScenario(providerPaymentId);
    if (scenario === "PENDING") return { providerPaymentId, status: "PENDING" };
    if (scenario === "FAILURE") {
      return {
        providerPaymentId,
        status: "FAILED",
        failureCode: "mock_declined",
        failureMessage: "The mock payment provider declined this payment (scenario=FAILURE).",
      };
    }
    return { providerPaymentId, status: "SUCCEEDED" };
  }

  verifyWebhook(rawBody: string, signatureHeader: string | undefined): PaymentWebhookEvent {
    if (!signatureHeader) {
      throw new PaymentWebhookSignatureError("Missing webhook signature");
    }
    const expected = sign(this.webhookSecret, rawBody);
    if (!safeEqual(expected, signatureHeader)) {
      throw new PaymentWebhookSignatureError("Webhook signature does not match payload");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new PaymentWebhookPayloadError("Webhook body is not valid JSON");
    }
    return parseWebhookEvent(parsed);
  }
}

function decodeScenario(providerPaymentId: string): PaymentScenario {
  if (providerPaymentId.startsWith("mock_pending_")) return "PENDING";
  if (providerPaymentId.startsWith("mock_failure_")) return "FAILURE";
  return "SUCCESS";
}

function parseWebhookEvent(value: unknown): PaymentWebhookEvent {
  if (typeof value !== "object" || value === null) {
    throw new PaymentWebhookPayloadError("Webhook body must be a JSON object");
  }
  const v = value as Record<string, unknown>;
  const eventId = v.eventId;
  const type = v.type;
  const providerPaymentId = v.providerPaymentId;
  const status = v.status;
  if (typeof eventId !== "string" || !eventId) {
    throw new PaymentWebhookPayloadError("Webhook body missing eventId");
  }
  if (type !== "payment.succeeded" && type !== "payment.failed" && type !== "payment.pending") {
    throw new PaymentWebhookPayloadError("Webhook body has an unknown event type");
  }
  if (typeof providerPaymentId !== "string" || !providerPaymentId) {
    throw new PaymentWebhookPayloadError("Webhook body missing providerPaymentId");
  }
  if (status !== "PENDING" && status !== "SUCCEEDED" && status !== "FAILED") {
    throw new PaymentWebhookPayloadError("Webhook body has an unknown status");
  }
  const failureCode = typeof v.failureCode === "string" ? v.failureCode : undefined;
  const failureMessage = typeof v.failureMessage === "string" ? v.failureMessage : undefined;
  return { eventId, type, providerPaymentId, status, failureCode, failureMessage };
}

// Test/dev-only helper: builds a signed webhook request body exactly the
// way an external delivery from the mock provider would look, so tests
// (and the frontend's "simulate outcome" action for a PENDING payment)
// can exercise the REAL POST /api/payments/webhook route — including its
// full signature verification — rather than bypassing it. Deliberately
// NOT part of the PaymentProvider interface: a real provider signs and
// delivers webhooks itself, over the network: nothing in this codebase
// would ever call an equivalent method on a real implementation.
export function buildMockWebhookRequest(
  webhookSecret: string,
  event: PaymentWebhookEvent,
): { body: string; signature: string } {
  const body = JSON.stringify(event);
  return { body, signature: sign(webhookSecret, body) };
}

export function eventTypeForStatus(status: PaymentProviderStatus): PaymentWebhookEventType {
  if (status === "SUCCEEDED") return "payment.succeeded";
  if (status === "FAILED") return "payment.failed";
  return "payment.pending";
}
