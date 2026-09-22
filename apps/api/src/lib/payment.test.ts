import { describe, expect, it } from "vitest";
import { assertPaymentStatusTransition, canTransitionPaymentStatus, hashPaymentRequest, PaymentStatusTransitionError } from "./payment.js";
import type { PaymentStatus } from "@pawlink/shared";

describe("canTransitionPaymentStatus / assertPaymentStatusTransition", () => {
  const valid: Array<[PaymentStatus, PaymentStatus]> = [
    ["CREATED", "PENDING"],
    ["CREATED", "SUCCEEDED"],
    ["CREATED", "FAILED"],
    ["PENDING", "SUCCEEDED"],
    ["PENDING", "FAILED"],
    ["PENDING", "CANCELLED"],
  ];

  it.each(valid)("allows %s -> %s", (from, to) => {
    expect(canTransitionPaymentStatus(from, to)).toBe(true);
    expect(() => assertPaymentStatusTransition(from, to)).not.toThrow();
  });

  const invalid: Array<[PaymentStatus, PaymentStatus]> = [
    // No self-transitions — a duplicate "succeeded" webhook for an
    // already-SUCCEEDED payment is handled by webhook event-id
    // idempotency, never by treating this as a legal transition.
    ["CREATED", "CREATED"],
    ["PENDING", "PENDING"],
    ["SUCCEEDED", "SUCCEEDED"],
    ["FAILED", "FAILED"],
    ["CANCELLED", "CANCELLED"],
    // Terminal states never transition out.
    ["SUCCEEDED", "PENDING"],
    ["SUCCEEDED", "FAILED"],
    ["SUCCEEDED", "CANCELLED"],
    ["SUCCEEDED", "CREATED"],
    ["FAILED", "SUCCEEDED"],
    ["FAILED", "PENDING"],
    ["FAILED", "CANCELLED"],
    ["CANCELLED", "SUCCEEDED"],
    ["CANCELLED", "PENDING"],
    ["CANCELLED", "FAILED"],
    // Out-of-order: PENDING can never regress back to CREATED.
    ["PENDING", "CREATED"],
  ];

  it.each(invalid)("rejects %s -> %s", (from, to) => {
    expect(canTransitionPaymentStatus(from, to)).toBe(false);
    expect(() => assertPaymentStatusTransition(from, to)).toThrow(PaymentStatusTransitionError);
  });
});

describe("hashPaymentRequest", () => {
  it("is deterministic for the same bookingId", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(hashPaymentRequest(id)).toBe(hashPaymentRequest(id));
  });

  it("differs for a different bookingId", () => {
    const a = hashPaymentRequest("11111111-1111-1111-1111-111111111111");
    const b = hashPaymentRequest("22222222-2222-2222-2222-222222222222");
    expect(a).not.toBe(b);
  });
});
