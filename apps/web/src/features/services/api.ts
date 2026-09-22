import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { CreateServiceInput, PublicService, UpdateServiceInput } from "./schemas";

type ServiceResponse = { service: PublicService };
type ServiceListResponse = { services: PublicService[] };

export async function listProviderServices(providerId: string): Promise<PublicService[]> {
  const { services } = await apiClient
    .get(`api/providers/${providerId}/services`)
    .json<ServiceListResponse>();
  return services;
}

export async function getProviderService(providerId: string, serviceId: string): Promise<PublicService> {
  const { service } = await apiClient
    .get(`api/providers/${providerId}/services/${serviceId}`)
    .json<ServiceResponse>();
  return service;
}

export async function createProviderService(
  providerId: string,
  input: CreateServiceInput,
): Promise<PublicService> {
  const { service } = await apiClient
    .post(`api/providers/${providerId}/services`, { json: input })
    .json<ServiceResponse>();
  return service;
}

export async function updateProviderService(
  providerId: string,
  serviceId: string,
  input: UpdateServiceInput,
): Promise<PublicService> {
  const { service } = await apiClient
    .patch(`api/providers/${providerId}/services/${serviceId}`, { json: input })
    .json<ServiceResponse>();
  return service;
}

// Soft deactivation — see apps/api/src/routes/services.ts. The row is
// kept (active -> false), not removed, so the response returns the (now
// inactive) service rather than nothing. Reactivation is
// updateProviderService(providerId, serviceId, { active: true }), not a
// separate function.
export async function deactivateProviderService(providerId: string, serviceId: string): Promise<PublicService> {
  const { service } = await apiClient
    .delete(`api/providers/${providerId}/services/${serviceId}`)
    .json<ServiceResponse>();
  return service;
}

export const providerServicesQueryOptions = (providerId: string) =>
  queryOptions({
    queryKey: ["providers", providerId, "services"] as const,
    queryFn: () => listProviderServices(providerId),
  });

export const providerServiceQueryOptions = (providerId: string, serviceId: string) =>
  queryOptions({
    queryKey: ["providers", providerId, "services", serviceId] as const,
    queryFn: () => getProviderService(providerId, serviceId),
  });
