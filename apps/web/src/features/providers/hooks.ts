import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createProvider,
  deactivateProvider,
  providerQueryOptions,
  providersQueryOptions,
  updateProvider,
  type ProviderFilters,
} from "./api";
import type { PublicProvider, UpdateProviderInput } from "./schemas";

export function useProviders(filters: ProviderFilters = {}) {
  return useQuery(providersQueryOptions(filters));
}

export function useProvider(id: string) {
  return useQuery(providerQueryOptions(id));
}

export function useCreateProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createProvider,
    onSuccess: (provider: PublicProvider) => {
      queryClient.setQueryData(providerQueryOptions(provider.id).queryKey, provider);
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}

export function useUpdateProvider(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProviderInput) => updateProvider(id, input),
    onSuccess: (provider: PublicProvider) => {
      queryClient.setQueryData(providerQueryOptions(provider.id).queryKey, provider);
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}

export function useDeactivateProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deactivateProvider,
    onSuccess: (provider: PublicProvider) => {
      queryClient.setQueryData(providerQueryOptions(provider.id).queryKey, provider);
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}
