import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bookingQueryOptions,
  bookingsQueryOptions,
  cancelBooking,
  createBooking,
  type BookingFilters,
} from "./api";
import type { CreateBookingInput, PublicBooking } from "./schemas";

export function useBookings(filters: BookingFilters = {}) {
  return useQuery(bookingsQueryOptions(filters));
}

export function useBooking(id: string) {
  return useQuery(bookingQueryOptions(id));
}

function invalidateAfterBookingChange(queryClient: ReturnType<typeof useQueryClient>, booking: PublicBooking) {
  queryClient.setQueryData(bookingQueryOptions(booking.id).queryKey, booking);
  queryClient.invalidateQueries({ queryKey: ["bookings"] });
  // A booking being created or cancelled changes which slots are free —
  // invalidate the whole availability branch for this provider (every
  // date/service combination) rather than trying to guess which one.
  queryClient.invalidateQueries({ queryKey: ["providers", booking.providerId, "availability"] });
}

// The idempotency key is supplied by the caller, not generated inside
// mutationFn — it must stay the SAME across every mutate() call that
// represents a retry of one logical confirm action (e.g. the network
// failed and the same "Confirm" click is retried), but be a genuinely
// NEW key for a separate booking attempt (a different slot, or the user
// starting over). That distinction is only knowable at the UI layer, so
// components own generating/holding the key (see BookingConfirmForm).
export function useCreateBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: { input: CreateBookingInput; idempotencyKey: string }) =>
      createBooking(input, idempotencyKey),
    onSuccess: (booking) => invalidateAfterBookingChange(queryClient, booking),
  });
}

export function useCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: cancelBooking,
    onSuccess: (booking) => invalidateAfterBookingChange(queryClient, booking),
  });
}
