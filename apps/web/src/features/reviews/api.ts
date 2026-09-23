import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { CreateReviewInput, PublicReview, ReviewListResponse, UpdateReviewInput } from "./schemas";

type ReviewResponse = { review: PublicReview };

export async function getBookingReview(bookingId: string): Promise<PublicReview> {
  const { review } = await apiClient.get(`api/bookings/${bookingId}/review`).json<ReviewResponse>();
  return review;
}

export async function createBookingReview(bookingId: string, input: CreateReviewInput): Promise<PublicReview> {
  const { review } = await apiClient.post(`api/bookings/${bookingId}/review`, { json: input }).json<ReviewResponse>();
  return review;
}

export async function updateReview(id: string, input: UpdateReviewInput): Promise<PublicReview> {
  const { review } = await apiClient.patch(`api/reviews/${id}`, { json: input }).json<ReviewResponse>();
  return review;
}

export async function listProviderReviews(providerId: string, page = 1, pageSize = 20): Promise<ReviewListResponse> {
  return apiClient
    .get(`api/providers/${providerId}/reviews`, { searchParams: { page: String(page), pageSize: String(pageSize) } })
    .json<ReviewListResponse>();
}

export const bookingReviewQueryOptions = (bookingId: string) =>
  queryOptions({
    queryKey: ["reviews", "booking", bookingId] as const,
    queryFn: () => getBookingReview(bookingId),
    enabled: !!bookingId,
    // A 404 here just means "no review yet" — a completely normal,
    // expected state for a freshly-completed booking, not a transient
    // failure worth retrying.
    retry: false,
  });

export const providerReviewsQueryOptions = (providerId: string, page = 1, pageSize = 20) =>
  queryOptions({
    queryKey: ["reviews", "provider", providerId, page, pageSize] as const,
    queryFn: () => listProviderReviews(providerId, page, pageSize),
    enabled: !!providerId,
  });
