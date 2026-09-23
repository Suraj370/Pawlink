import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminAuditQueryOptions,
  adminBookingsQueryOptions,
  adminDashboardQueryOptions,
  adminPaymentsQueryOptions,
  adminProvidersQueryOptions,
  adminReviewsQueryOptions,
  adminUsersQueryOptions,
  hideAdminReview,
  publishAdminReview,
  setAdminProviderStatus,
} from "./api";
import type {
  AdminAuditListQuery,
  AdminBookingListQuery,
  AdminPaymentListQuery,
  AdminProviderListQuery,
  AdminReviewListQuery,
  AdminUserListQuery,
} from "./schemas";

export function useAdminDashboard() {
  return useQuery(adminDashboardQueryOptions());
}

export function useAdminProviders(query: Partial<AdminProviderListQuery> = {}) {
  return useQuery(adminProvidersQueryOptions(query));
}

export function useSetAdminProviderStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => setAdminProviderStatus(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "providers"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "audit"] });
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}

export function useAdminUsers(query: Partial<AdminUserListQuery> = {}) {
  return useQuery(adminUsersQueryOptions(query));
}

export function useAdminBookings(query: Partial<AdminBookingListQuery> = {}) {
  return useQuery(adminBookingsQueryOptions(query));
}

export function useAdminPayments(query: Partial<AdminPaymentListQuery> = {}) {
  return useQuery(adminPaymentsQueryOptions(query));
}

export function useAdminReviews(query: Partial<AdminReviewListQuery> = {}) {
  return useQuery(adminReviewsQueryOptions(query));
}

export function useModerateAdminReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "hide" | "publish" }) =>
      action === "hide" ? hideAdminReview(id) : publishAdminReview(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "reviews"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "audit"] });
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}

export function useAdminAudit(query: Partial<AdminAuditListQuery> = {}) {
  return useQuery(adminAuditQueryOptions(query));
}
