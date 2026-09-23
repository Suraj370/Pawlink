import type { AdminBookingSummary, AdminPayment, AdminUser } from "@pawlink/shared";
import type { bookings, payments, users } from "../db/schema.js";

type UserRow = typeof users.$inferSelect;
type BookingRow = typeof bookings.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;

// Deliberately minimal — id, display name, role, created date, exactly
// what the milestone brief asks for and nothing else. No email, no
// phone, no updatedAt. See docs/architecture.md, "Admin & operations —
// data minimization."
export function toAdminUser(user: UserRow): AdminUser {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toAdminPayment(payment: PaymentRow): AdminPayment {
  return {
    id: payment.id,
    bookingId: payment.bookingId,
    provider: payment.provider,
    // Judged safe for operational visibility — a correlation id, never a
    // credential, signature, or secret. See docs/architecture.md, "Admin
    // payment visibility."
    providerPaymentId: payment.providerPaymentId,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    status: payment.status,
    failureCode: payment.failureCode,
    failureMessage: payment.failureMessage,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

// The "operational" payment status for a booking, derived from its
// (possibly several — see docs/architecture.md, "Duplicate payment
// protection") payment attempt rows: the SUCCEEDED one if any attempt
// reached it, otherwise the most recently updated attempt's status,
// otherwise "NONE" if payment was never attempted at all. Never a raw
// database join exposed as-is — this is a deliberate, documented
// collapsing of "0 or more payment rows" into the single status an
// admin list view actually needs.
export function derivePaymentStatusForBooking(bookingPayments: PaymentRow[]): AdminPayment["status"] | "NONE" {
  if (bookingPayments.length === 0) return "NONE";
  const succeeded = bookingPayments.find((p) => p.status === "SUCCEEDED");
  if (succeeded) return "SUCCEEDED";
  const mostRecent = [...bookingPayments].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  return mostRecent.status;
}

export function toAdminBookingSummary(
  booking: BookingRow,
  context: { customerName: string; providerName: string; paymentStatus: AdminPayment["status"] | "NONE" },
): AdminBookingSummary {
  return {
    id: booking.id,
    customerName: context.customerName,
    providerId: booking.providerId,
    providerName: context.providerName,
    serviceName: booking.serviceNameSnapshot,
    startAt: booking.startAt.toISOString(),
    endAt: booking.endAt.toISOString(),
    status: booking.status,
    paymentStatus: context.paymentStatus,
    priceMinor: booking.priceMinor,
    currency: booking.currency,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
  };
}
