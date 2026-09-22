import { describe, expect, it } from "vitest";
import {
  buildMockWebhookRequest,
  MockPaymentProvider,
  PaymentWebhookPayloadError,
  PaymentWebhookSignatureError,
  sign,
} from "./payment-provider.js";

const SECRET = "test-secret";

describe("MockPaymentProvider.createPayment — deterministic, never random", () => {
  const provider = new MockPaymentProvider(SECRET);

  it("scenario=SUCCESS always resolves SUCCEEDED", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        provider.createPayment({ paymentId: "p1", bookingId: "b1", amountMinor: 100, currency: "INR", scenario: "SUCCESS" }),
      ),
    );
    expect(results.every((r) => r.status === "SUCCEEDED")).toBe(true);
    // Same input -> same providerPaymentId every time (deterministic).
    expect(new Set(results.map((r) => r.providerPaymentId)).size).toBe(1);
  });

  it("scenario=FAILURE always resolves FAILED with failure details", async () => {
    const result = await provider.createPayment({ paymentId: "p2", bookingId: "b1", amountMinor: 100, currency: "INR", scenario: "FAILURE" });
    expect(result.status).toBe("FAILED");
    expect(result.failureCode).toBeTruthy();
    expect(result.failureMessage).toBeTruthy();
  });

  it("scenario=PENDING always resolves PENDING", async () => {
    const result = await provider.createPayment({ paymentId: "p3", bookingId: "b1", amountMinor: 100, currency: "INR", scenario: "PENDING" });
    expect(result.status).toBe("PENDING");
  });

  it("getPayment reports the same status createPayment returned, purely from the id", async () => {
    const created = await provider.createPayment({ paymentId: "p4", bookingId: "b1", amountMinor: 100, currency: "INR", scenario: "FAILURE" });
    const fetched = await provider.getPayment(created.providerPaymentId);
    expect(fetched.status).toBe("FAILED");
  });
});

describe("MockPaymentProvider.verifyWebhook", () => {
  const provider = new MockPaymentProvider(SECRET);

  it("accepts a correctly-signed, well-formed event", () => {
    const { body, signature } = buildMockWebhookRequest(SECRET, {
      eventId: "evt_1",
      type: "payment.succeeded",
      providerPaymentId: "mock_success_x",
      status: "SUCCEEDED",
    });
    const event = provider.verifyWebhook(body, signature);
    expect(event.eventId).toBe("evt_1");
    expect(event.status).toBe("SUCCEEDED");
  });

  it("rejects a missing signature", () => {
    const { body } = buildMockWebhookRequest(SECRET, {
      eventId: "evt_2",
      type: "payment.succeeded",
      providerPaymentId: "x",
      status: "SUCCEEDED",
    });
    expect(() => provider.verifyWebhook(body, undefined)).toThrow(PaymentWebhookSignatureError);
  });

  it("rejects a signature computed with a different secret", () => {
    const { body } = buildMockWebhookRequest("a-different-secret", {
      eventId: "evt_3",
      type: "payment.succeeded",
      providerPaymentId: "x",
      status: "SUCCEEDED",
    });
    const wrongSignature = sign("a-different-secret", body);
    // Sanity: the wrong-secret signature DOES verify against its own
    // body when checked with that same wrong secret...
    expect(new MockPaymentProvider("a-different-secret").verifyWebhook(body, wrongSignature).eventId).toBe("evt_3");
    // ...but not against OUR provider's real secret.
    expect(() => provider.verifyWebhook(body, wrongSignature)).toThrow(PaymentWebhookSignatureError);
  });

  it("rejects a body that isn't valid JSON at all (fails the signature check first)", () => {
    const garbage = "{not json";
    const signature = sign(SECRET, garbage);
    // A well-signed garbage body still fails, but for a DIFFERENT reason
    // (payload shape) — verified in the next test. Here, an unsigned/
    // wrongly-signed garbage body fails on signature, same as any other
    // tampered payload.
    expect(() => provider.verifyWebhook(garbage, undefined)).toThrow(PaymentWebhookSignatureError);
    expect(() => provider.verifyWebhook(garbage, signature)).toThrow(PaymentWebhookPayloadError);
  });

  it("rejects a well-signed but structurally invalid payload", () => {
    const body = JSON.stringify({ foo: "bar" });
    const signature = sign(SECRET, body);
    expect(() => provider.verifyWebhook(body, signature)).toThrow(PaymentWebhookPayloadError);
  });

  it("rejects a well-signed payload with an unknown event type", () => {
    const body = JSON.stringify({ eventId: "evt_6", type: "payment.refunded", providerPaymentId: "z", status: "SUCCEEDED" });
    const signature = sign(SECRET, body);
    expect(() => provider.verifyWebhook(body, signature)).toThrow(PaymentWebhookPayloadError);
  });
});
