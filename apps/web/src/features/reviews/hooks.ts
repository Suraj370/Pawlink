import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bookingReviewQueryOptions,
  createBookingReview,
  providerReviewsQueryOptions,
  updateReview,
} from "./api";
import type { CreateReviewInput, PublicReview, UpdateReviewInput } from "./schemas";

export function useBookingReview(bookingId: string) {
  return useQuery(bookingReviewQueryOptions(bookingId));
}

export function useProviderReviews(providerId: string, page = 1, pageSize = 20) {
  return useQuery(providerReviewsQueryOptions(providerId, page, pageSize));
}

// A review changes two things at once: the booking's own review state,
// and the provider's public aggregate rating — both are invalidated on
// every create/edit so neither view can show stale data after a mutation.
function invalidateAfterReviewChange(queryClient: ReturnType<typeof useQueryClient>, review: PublicReview) {
  queryClient.setQueryData(bookingReviewQueryOptions(review.bookingId).queryKey, review);
  queryClient.invalidateQueries({ queryKey: ["reviews", "provider", review.providerId] });
  queryClient.invalidateQueries({ queryKey: ["providers", review.providerId] });
  queryClient.invalidateQueries({ queryKey: ["providers"] });
}

export function useCreateBookingReview(bookingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateReviewInput) => createBookingReview(bookingId, input),
    onSuccess: (review) => invalidateAfterReviewChange(queryClient, review),
  });
}

export function useUpdateReview(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateReviewInput) => updateReview(id, input),
    onSuccess: (review) => invalidateAfterReviewChange(queryClient, review),
  });
}
