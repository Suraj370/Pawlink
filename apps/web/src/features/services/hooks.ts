import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createProviderService,
  deactivateProviderService,
  providerServiceQueryOptions,
  providerServicesQueryOptions,
  updateProviderService,
} from "./api";
import type { CreateServiceInput, PublicService, UpdateServiceInput } from "./schemas";

export function useProviderServices(providerId: string) {
  return useQuery(providerServicesQueryOptions(providerId));
}

export function useProviderService(providerId: string, serviceId: string) {
  return useQuery(providerServiceQueryOptions(providerId, serviceId));
}

function invalidateServiceQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  providerId: string,
  service: PublicService,
) {
  queryClient.setQueryData(providerServiceQueryOptions(providerId, service.id).queryKey, service);
  queryClient.invalidateQueries({ queryKey: providerServicesQueryOptions(providerId).queryKey });
}

export function useCreateProviderService(providerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateServiceInput) => createProviderService(providerId, input),
    onSuccess: (service) => invalidateServiceQueries(queryClient, providerId, service),
  });
}

export function useUpdateProviderService(providerId: string, serviceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateServiceInput) => updateProviderService(providerId, serviceId, input),
    onSuccess: (service) => invalidateServiceQueries(queryClient, providerId, service),
  });
}

export function useDeactivateProviderService(providerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string) => deactivateProviderService(providerId, serviceId),
    onSuccess: (service) => invalidateServiceQueries(queryClient, providerId, service),
  });
}
