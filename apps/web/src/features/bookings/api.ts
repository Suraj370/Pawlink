import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { BookingListQuery, CreateBookingInput, PublicBooking } from "./schemas";

type BookingResponse = { booking: PublicBooking };
type BookingListResponse = {
  bookings: PublicBooking[];
  page: number;
  pageSize: number;
  total: number;
};

export type BookingFilters = Partial<Omit<BookingListQuery, "page" | "pageSize">> & {
  page?: number;
  pageSize?: number;
};

// idempotencyKey is a plain parameter, not baked into CreateBookingInput
// — it's transport-level (an HTTP header), not part of what the booking
// actually represents.
export async function createBooking(input: CreateBookingInput, idempotencyKey: string): Promise<PublicBooking> {
  const { booking } = await apiClient
    .post("api/bookings", { json: input, headers: { "Idempotency-Key": idempotencyKey } })
    .json<BookingResponse>();
  return booking;
}

export async function listBookings(filters: BookingFilters = {}): Promise<BookingListResponse> {
  const searchParams: Record<string, string> = {};
  if (filters.providerId) searchParams.providerId = filters.providerId;
  if (filters.status) searchParams.status = filters.status;
  if (filters.when) searchParams.when = filters.when;
  if (filters.page) searchParams.page = String(filters.page);
  if (filters.pageSize) searchParams.pageSize = String(filters.pageSize);

  return apiClient.get("api/bookings", { searchParams }).json<BookingListResponse>();
}

export async function getBooking(id: string): Promise<PublicBooking> {
  const { booking } = await apiClient.get(`api/bookings/${id}`).json<BookingResponse>();
  return booking;
}

export async function cancelBooking(id: string): Promise<PublicBooking> {
  const { booking } = await apiClient.post(`api/bookings/${id}/cancel`).json<BookingResponse>();
  return booking;
}

export const bookingsQueryOptions = (filters: BookingFilters = {}) =>
  queryOptions({
    queryKey: ["bookings", filters] as const,
    queryFn: () => listBookings(filters),
  });

export const bookingQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["bookings", id] as const,
    queryFn: () => getBooking(id),
  });
