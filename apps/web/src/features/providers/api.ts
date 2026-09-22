import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { CreateProviderInput, ProviderType, PublicProvider, UpdateProviderInput } from "./schemas";

export type ProviderFilters = {
  providerType?: ProviderType;
  city?: string;
  page?: number;
  pageSize?: number;
};

type ProviderResponse = { provider: PublicProvider };
type ProviderListResponse = {
  providers: PublicProvider[];
  page: number;
  pageSize: number;
  total: number;
};

export async function listProviders(filters: ProviderFilters = {}): Promise<ProviderListResponse> {
  const searchParams: Record<string, string> = {};
  if (filters.providerType) searchParams.providerType = filters.providerType;
  if (filters.city) searchParams.city = filters.city;
  if (filters.page) searchParams.page = String(filters.page);
  if (filters.pageSize) searchParams.pageSize = String(filters.pageSize);

  return apiClient.get("api/providers", { searchParams }).json<ProviderListResponse>();
}

export async function getProvider(id: string): Promise<PublicProvider> {
  const { provider } = await apiClient.get(`api/providers/${id}`).json<ProviderResponse>();
  return provider;
}

export async function createProvider(input: CreateProviderInput): Promise<PublicProvider> {
  const { provider } = await apiClient.post("api/providers", { json: input }).json<ProviderResponse>();
  return provider;
}

export async function updateProvider(id: string, input: UpdateProviderInput): Promise<PublicProvider> {
  const { provider } = await apiClient.patch(`api/providers/${id}`, { json: input }).json<ProviderResponse>();
  return provider;
}

// Soft deactivation — see apps/api/src/routes/providers.ts. The provider
// row is kept (status -> INACTIVE), not removed, so the response still
// returns the (now inactive) provider rather than nothing.
export async function deactivateProvider(id: string): Promise<PublicProvider> {
  const { provider } = await apiClient.delete(`api/providers/${id}`).json<ProviderResponse>();
  return provider;
}

export const providersQueryOptions = (filters: ProviderFilters = {}) =>
  queryOptions({
    queryKey: ["providers", filters] as const,
    queryFn: () => listProviders(filters),
  });

export const providerQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["providers", id] as const,
    queryFn: () => getProvider(id),
  });
