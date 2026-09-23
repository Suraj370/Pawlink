import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authMeQueryOptions, login, logout, register } from "./api";
import type { PublicUser } from "./schemas";

export function useCurrentUser() {
  return useQuery(authMeQueryOptions);
}

// Every auth transition (register/login/logout) clears the ENTIRE
// TanStack Query cache, not just the auth/me entry — see
// docs/architecture.md, "Production hardening — TanStack Query cache
// isolation." Without this, a query cached under one session (bookings,
// medical records, admin lists, anything) can survive into a DIFFERENT
// session on the same browser tab: logging out and logging back in as
// someone else, or one account logging out and a different one logging
// in, would otherwise let the new session's first render show the
// previous user's cached data before the corresponding refetch resolves
// — a real cross-user data leak on a shared device, not just a UX
// glitch. queryClient.clear() is unconditional and cheap (every
// remaining query simply refetches on next mount), so this is the
// correct default rather than an allowlist of "sensitive" query keys to
// remember to clear.
export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: register,
    onSuccess: (user: PublicUser) => {
      queryClient.clear();
      queryClient.setQueryData(authMeQueryOptions.queryKey, user);
    },
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: login,
    onSuccess: (user: PublicUser) => {
      queryClient.clear();
      queryClient.setQueryData(authMeQueryOptions.queryKey, user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear();
    },
  });
}
