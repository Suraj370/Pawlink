import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authMeQueryOptions, login, logout, register } from "./api";
import type { PublicUser } from "./schemas";

export function useCurrentUser() {
  return useQuery(authMeQueryOptions);
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: register,
    onSuccess: (user: PublicUser) => {
      queryClient.setQueryData(authMeQueryOptions.queryKey, user);
    },
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: login,
    onSuccess: (user: PublicUser) => {
      queryClient.setQueryData(authMeQueryOptions.queryKey, user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: authMeQueryOptions.queryKey });
    },
  });
}
