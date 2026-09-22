import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { CreatePaymentInput, PublicPayment } from "./schemas";

type PaymentResponse = { payment: PublicPayment };
type BookingPaymentResponse = { payment: PublicPayment | null };

// idempotencyKey is a transport-level header, not part of the payment
// input itself — same rationale as createBooking in features/bookings/api.ts.
export async function createPayment(
  bookingId: string,
  input: CreatePaymentInput,
  idempotencyKey: string,
): Promise<PublicPayment> {
  const { payment } = await apiClient
    .post(`api/bookings/${bookingId}/payment`, { json: input, headers: { "Idempotency-Key": idempotencyKey } })
    .json<PaymentResponse>();
  return payment;
}

export async function getBookingPayment(bookingId: string): Promise<PublicPayment | null> {
  const { payment } = await apiClient.get(`api/bookings/${bookingId}/payment`).json<BookingPaymentResponse>();
  return payment;
}

export const bookingPaymentQueryOptions = (bookingId: string) =>
  queryOptions({
    queryKey: ["bookings", bookingId, "payment"] as const,
    queryFn: () => getBookingPayment(bookingId),
  });
