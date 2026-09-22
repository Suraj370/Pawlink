import { z } from "zod";

export const DAY_OF_WEEK_VALUES = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;
export const dayOfWeekSchema = z.enum(DAY_OF_WEEK_VALUES);
export type DayOfWeek = z.infer<typeof dayOfWeekSchema>;

export const EXCEPTION_TYPE_VALUES = ["CLOSED", "CUSTOM_HOURS"] as const;
export const exceptionTypeSchema = z.enum(EXCEPTION_TYPE_VALUES);
export type ExceptionType = z.infer<typeof exceptionTypeSchema>;

// "HH:MM" 24-hour local wall-clock time (no seconds, no timezone — see
// apps/api/src/lib/timezone.ts for the full date/time model rationale).
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const localTimeSchema = z.string().regex(TIME_RE, "Time must be in HH:MM 24-hour format");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The regex alone only checks digit shape — "2031-13-45" matches it but
// isn't a real calendar date. Without this refinement, a string like that
// would sail past validation and only fail deep inside a Postgres `date`
// query (a raw 500, not a clean 400) — so the calendar-validity check
// belongs here, at the boundary.
function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

export const isoDateSchema = z
  .string()
  .regex(DATE_RE, "Date must be in YYYY-MM-DD format")
  .refine(isRealCalendarDate, { message: "Date must be a real calendar date" });

// Intl.DateTimeFormat with an explicit timeZone is standard in both
// Node and modern browsers, so this single implementation is the
// authoritative timezone validator for both the API and the frontend —
// no duplicated/divergent copies.
//
// ICU's alias table is lenient enough to silently accept bare
// abbreviations like "IST" or "PST" (resolving them to some concrete
// zone, e.g. "IST" -> "Asia/Calcutta") — exactly the kind of ambiguous
// fixed-offset/abbreviation input a provider's timezone must reject. A
// real IANA identifier is either the single special case "UTC" or an
// Area/Location pair, so requiring that shape first is what actually
// catches this; Intl.DateTimeFormat alone does not.
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string") return false;
  const trimmed = timeZone.trim();
  if (trimmed === "") return false;
  if (trimmed !== "UTC" && !trimmed.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z
  .string()
  .trim()
  .min(1, "Timezone is required")
  .refine(isValidTimeZone, {
    message: "Timezone must be a real IANA identifier (e.g. Asia/Kolkata), not an abbreviation or offset",
  });

export const weeklyRuleInputSchema = z
  .object({
    dayOfWeek: dayOfWeekSchema,
    startTime: localTimeSchema,
    endTime: localTimeSchema,
  })
  .refine((rule) => rule.endTime > rule.startTime, {
    message: "endTime must be after startTime",
    path: ["endTime"],
  });
export type WeeklyRuleInput = z.infer<typeof weeklyRuleInputSchema>;

export const publicWeeklyRuleSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  dayOfWeek: dayOfWeekSchema,
  startTime: z.string(),
  endTime: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicWeeklyRule = z.infer<typeof publicWeeklyRuleSchema>;

export const exceptionInputSchema = z
  .object({
    date: isoDateSchema,
    type: exceptionTypeSchema,
    startTime: localTimeSchema.optional(),
    endTime: localTimeSchema.optional(),
    reason: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().max(500).optional(),
    ),
  })
  .superRefine((data, ctx) => {
    if (data.type === "CLOSED") {
      if (data.startTime !== undefined || data.endTime !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A CLOSED exception must not include startTime/endTime",
          path: ["type"],
        });
      }
      return;
    }
    // CUSTOM_HOURS
    if (data.startTime === undefined || data.endTime === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A CUSTOM_HOURS exception requires both startTime and endTime",
        path: ["type"],
      });
      return;
    }
    if (data.endTime <= data.startTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endTime must be after startTime",
        path: ["endTime"],
      });
    }
  });
export type ExceptionInput = z.infer<typeof exceptionInputSchema>;

export const publicExceptionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  date: z.string(),
  type: exceptionTypeSchema,
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicException = z.infer<typeof publicExceptionSchema>;

export const availabilityQuerySchema = z.object({
  date: isoDateSchema,
  serviceId: z.string().uuid("serviceId must be a valid id"),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

// Timestamps carry the provider's own UTC offset (e.g.
// "2026-10-05T09:00:00+05:30"), never a bare "Z" — see
// apps/api/src/lib/timezone.ts. This is what makes each slot's wall-clock
// meaning unambiguous without the client needing to separately know the
// provider's zone.
export const availabilityResponseSchema = z.object({
  date: isoDateSchema,
  timezone: z.string(),
  slotIntervalMinutes: z.number(),
  serviceDurationMinutes: z.number(),
  slots: z.array(z.string()),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;
