import type { PublicException, PublicWeeklyRule } from "@pawlink/shared";
import type { availabilityExceptions, providerAvailability } from "../db/schema.js";

type WeeklyRuleRow = typeof providerAvailability.$inferSelect;
type ExceptionRow = typeof availabilityExceptions.$inferSelect;

export function toPublicWeeklyRule(rule: WeeklyRuleRow): PublicWeeklyRule {
  return {
    id: rule.id,
    providerId: rule.providerId,
    dayOfWeek: rule.dayOfWeek,
    startTime: rule.startTime,
    endTime: rule.endTime,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

export function toPublicException(exception: ExceptionRow): PublicException {
  return {
    id: exception.id,
    providerId: exception.providerId,
    date: exception.date,
    type: exception.type,
    startTime: exception.startTime,
    endTime: exception.endTime,
    reason: exception.reason,
    createdAt: exception.createdAt.toISOString(),
    updatedAt: exception.updatedAt.toISOString(),
  };
}
