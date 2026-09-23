import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type {
  AdminAuditEntry,
  AdminBookingListQuery,
  AdminBookingSummary,
  AdminDashboardSummary,
  AdminPayment,
  AdminPaymentListQuery,
  AdminProviderListQuery,
  AdminReviewListQuery,
  AdminUser,
  AdminUserListQuery,
  PublicProvider,
  PublicReview,
} from "./schemas";

type Page<T> = { page: number; pageSize: number; total: number } & T;

function toSearchParams(query: Record<string, string | number | undefined>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params[key] = String(value);
  }
  return params;
}

export async function getAdminDashboard(): Promise<AdminDashboardSummary> {
  return apiClient.get("api/admin/dashboard").json<AdminDashboardSummary>();
}

export async function listAdminProviders(
  query: Partial<AdminProviderListQuery> = {},
): Promise<Page<{ providers: PublicProvider[] }>> {
  return apiClient
    .get("api/admin/providers", { searchParams: toSearchParams(query) })
    .json<Page<{ providers: PublicProvider[] }>>();
}

export async function setAdminProviderStatus(id: string, status: string): Promise<PublicProvider> {
  const { provider } = await apiClient
    .post(`api/admin/providers/${id}/status`, { json: { status } })
    .json<{ provider: PublicProvider }>();
  return provider;
}

export async function listAdminUsers(query: Partial<AdminUserListQuery> = {}): Promise<Page<{ users: AdminUser[] }>> {
  return apiClient.get("api/admin/users", { searchParams: toSearchParams(query) }).json<Page<{ users: AdminUser[] }>>();
}

export async function listAdminBookings(
  query: Partial<AdminBookingListQuery> = {},
): Promise<Page<{ bookings: AdminBookingSummary[] }>> {
  return apiClient
    .get("api/admin/bookings", { searchParams: toSearchParams(query) })
    .json<Page<{ bookings: AdminBookingSummary[] }>>();
}

export async function listAdminPayments(
  query: Partial<AdminPaymentListQuery> = {},
): Promise<Page<{ payments: AdminPayment[] }>> {
  return apiClient
    .get("api/admin/payments", { searchParams: toSearchParams(query) })
    .json<Page<{ payments: AdminPayment[] }>>();
}

export async function listAdminReviews(
  query: Partial<AdminReviewListQuery> = {},
): Promise<Page<{ reviews: PublicReview[] }>> {
  return apiClient
    .get("api/admin/reviews", { searchParams: toSearchParams(query) })
    .json<Page<{ reviews: PublicReview[] }>>();
}

export async function hideAdminReview(id: string): Promise<PublicReview> {
  const { review } = await apiClient.post(`api/admin/reviews/${id}/hide`).json<{ review: PublicReview }>();
  return review;
}

export async function publishAdminReview(id: string): Promise<PublicReview> {
  const { review } = await apiClient.post(`api/admin/reviews/${id}/publish`).json<{ review: PublicReview }>();
  return review;
}

export async function listAdminAudit(
  query: { action?: string; resourceType?: string; page?: number; pageSize?: number } = {},
): Promise<Page<{ entries: AdminAuditEntry[] }>> {
  return apiClient
    .get("api/admin/audit", { searchParams: toSearchParams(query) })
    .json<Page<{ entries: AdminAuditEntry[] }>>();
}

export const adminDashboardQueryOptions = () =>
  queryOptions({ queryKey: ["admin", "dashboard"] as const, queryFn: getAdminDashboard });

export const adminProvidersQueryOptions = (query: Partial<AdminProviderListQuery> = {}) =>
  queryOptions({ queryKey: ["admin", "providers", query] as const, queryFn: () => listAdminProviders(query) });

export const adminUsersQueryOptions = (query: Partial<AdminUserListQuery> = {}) =>
  queryOptions({ queryKey: ["admin", "users", query] as const, queryFn: () => listAdminUsers(query) });

export const adminBookingsQueryOptions = (query: Partial<AdminBookingListQuery> = {}) =>
  queryOptions({ queryKey: ["admin", "bookings", query] as const, queryFn: () => listAdminBookings(query) });

export const adminPaymentsQueryOptions = (query: Partial<AdminPaymentListQuery> = {}) =>
  queryOptions({ queryKey: ["admin", "payments", query] as const, queryFn: () => listAdminPayments(query) });

export const adminReviewsQueryOptions = (query: Partial<AdminReviewListQuery> = {}) =>
  queryOptions({ queryKey: ["admin", "reviews", query] as const, queryFn: () => listAdminReviews(query) });

export const adminAuditQueryOptions = (
  query: { action?: string; resourceType?: string; page?: number; pageSize?: number } = {},
) => queryOptions({ queryKey: ["admin", "audit", query] as const, queryFn: () => listAdminAudit(query) });
