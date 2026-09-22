import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

type HealthResponse = {
  status: "ok";
  service: string;
  timestamp: string;
};

export async function getApiHealth(): Promise<HealthResponse> {
  return apiClient.get("health").json<HealthResponse>();
}

export const apiHealthQueryOptions = queryOptions({
  queryKey: ["system", "health"] as const,
  queryFn: getApiHealth,
  retry: false,
  staleTime: 10_000,
});
