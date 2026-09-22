import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  availabilityQueryOptions,
  createException,
  createWeeklyRule,
  deleteException,
  deleteWeeklyRule,
  exceptionsQueryOptions,
  updateWeeklyRule,
  weeklyRulesQueryOptions,
  type AvailabilityQueryInput,
} from "./api";
import type { ExceptionInput, WeeklyRuleInput } from "./schemas";

export function useAvailability(providerId: string, query: AvailabilityQueryInput, enabled: boolean) {
  return useQuery({ ...availabilityQueryOptions(providerId, query), enabled });
}

export function useWeeklyRules(providerId: string) {
  return useQuery(weeklyRulesQueryOptions(providerId));
}

export function useExceptions(providerId: string) {
  return useQuery(exceptionsQueryOptions(providerId));
}

// Any rule/exception change can change every computed slot for this
// provider, for every date/service combination — so the whole
// ["providers", providerId, "availability"] branch (the calculation
// query's cache included, via prefix match) is invalidated rather than
// trying to guess which specific date/service queries are affected.
function invalidateAvailability(queryClient: ReturnType<typeof useQueryClient>, providerId: string) {
  queryClient.invalidateQueries({ queryKey: ["providers", providerId, "availability"] });
}

export function useCreateWeeklyRule(providerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WeeklyRuleInput) => createWeeklyRule(providerId, input),
    onSuccess: () => invalidateAvailability(queryClient, providerId),
  });
}

export function useUpdateWeeklyRule(providerId: string, ruleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WeeklyRuleInput) => updateWeeklyRule(providerId, ruleId, input),
    onSuccess: () => invalidateAvailability(queryClient, providerId),
  });
}

export function useDeleteWeeklyRule(providerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) => deleteWeeklyRule(providerId, ruleId),
    onSuccess: () => invalidateAvailability(queryClient, providerId),
  });
}

export function useCreateException(providerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ExceptionInput) => createException(providerId, input),
    onSuccess: () => invalidateAvailability(queryClient, providerId),
  });
}

export function useDeleteException(providerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (exceptionId: string) => deleteException(providerId, exceptionId),
    onSuccess: () => invalidateAvailability(queryClient, providerId),
  });
}
