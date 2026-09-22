import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { AvailabilityResponse, ExceptionInput, PublicException, PublicWeeklyRule, WeeklyRuleInput } from "./schemas";

type RuleResponse = { rule: PublicWeeklyRule };
type RulesListResponse = { rules: PublicWeeklyRule[] };
type ExceptionResponse = { exception: PublicException };
type ExceptionsListResponse = { exceptions: PublicException[] };

export type AvailabilityQueryInput = {
  date: string;
  serviceId: string;
};

export async function getAvailability(providerId: string, query: AvailabilityQueryInput): Promise<AvailabilityResponse> {
  return apiClient
    .get(`api/providers/${providerId}/availability`, {
      searchParams: { date: query.date, serviceId: query.serviceId },
    })
    .json<AvailabilityResponse>();
}

export async function listWeeklyRules(providerId: string): Promise<PublicWeeklyRule[]> {
  const { rules } = await apiClient.get(`api/providers/${providerId}/availability/rules`).json<RulesListResponse>();
  return rules;
}

export async function createWeeklyRule(providerId: string, input: WeeklyRuleInput): Promise<PublicWeeklyRule> {
  const { rule } = await apiClient
    .post(`api/providers/${providerId}/availability/rules`, { json: input })
    .json<RuleResponse>();
  return rule;
}

export async function updateWeeklyRule(
  providerId: string,
  ruleId: string,
  input: WeeklyRuleInput,
): Promise<PublicWeeklyRule> {
  const { rule } = await apiClient
    .patch(`api/providers/${providerId}/availability/rules/${ruleId}`, { json: input })
    .json<RuleResponse>();
  return rule;
}

export async function deleteWeeklyRule(providerId: string, ruleId: string): Promise<void> {
  await apiClient.delete(`api/providers/${providerId}/availability/rules/${ruleId}`);
}

export async function listExceptions(providerId: string): Promise<PublicException[]> {
  const { exceptions } = await apiClient
    .get(`api/providers/${providerId}/availability/exceptions`)
    .json<ExceptionsListResponse>();
  return exceptions;
}

export async function createException(providerId: string, input: ExceptionInput): Promise<PublicException> {
  const { exception } = await apiClient
    .post(`api/providers/${providerId}/availability/exceptions`, { json: input })
    .json<ExceptionResponse>();
  return exception;
}

export async function deleteException(providerId: string, exceptionId: string): Promise<void> {
  await apiClient.delete(`api/providers/${providerId}/availability/exceptions/${exceptionId}`);
}

export const availabilityQueryOptions = (providerId: string, query: AvailabilityQueryInput) =>
  queryOptions({
    queryKey: ["providers", providerId, "availability", query] as const,
    queryFn: () => getAvailability(providerId, query),
  });

export const weeklyRulesQueryOptions = (providerId: string) =>
  queryOptions({
    queryKey: ["providers", providerId, "availability", "rules"] as const,
    queryFn: () => listWeeklyRules(providerId),
  });

export const exceptionsQueryOptions = (providerId: string) =>
  queryOptions({
    queryKey: ["providers", providerId, "availability", "exceptions"] as const,
    queryFn: () => listExceptions(providerId),
  });
