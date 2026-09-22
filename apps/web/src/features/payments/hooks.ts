import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { bookingQueryOptions } from "@/features/bookings/api";
import { bookingPaymentQueryOptions, createPayment } from "./api";
import type { CreatePaymentInput, PublicPayment } from "./schemas";

export function useBookingPayment(bookingId: string) {
  return useQuery(bookingPaymentQueryOptions(bookingId));
}

// The idempotency key is supplied by the caller (component state), not
// generated inside mutationFn — same rationale as useCreateBooking: it
// must stay the SAME across a retry of one logical "pay" action, but be
// fresh for a genuinely new attempt.
export function useCreatePayment(bookingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: { input: CreatePaymentInput; idempotencyKey: string }) =>
      createPayment(bookingId, input, idempotencyKey),
    onSuccess: (payment: PublicPayment) => {
      queryClient.setQueryData(bookingPaymentQueryOptions(bookingId).queryKey, payment);
      // A payment outcome can change the booking's own status
      // (PENDING -> CONFIRMED or PENDING -> CANCELLED) — refetch it
      // rather than trusting anything computed client-side. The server
      // remains the sole authority on booking status.
      queryClient.invalidateQueries({ queryKey: bookingQueryOptions(bookingId).queryKey });
      queryClient.invalidateQueries({ queryKey: ["bookings"] });
    },
  });
}
