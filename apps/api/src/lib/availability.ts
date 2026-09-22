import { dayOfWeekForDate, formatZonedIso, zonedTimeToUtc } from "./timezone.js";

// Domain constant, not a magic number scattered through the codebase.
// Documented decision: 30-minute slots for this first version. Every slot
// boundary in the system is derived from this single constant, so a future
// per-provider configurable interval only has to change how this value is
// obtained, not the algorithm itself.
export const SLOT_INTERVAL_MINUTES = 30;

export type DayOfWeek =
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY"
  | "SUNDAY";

// start/end are "HH:MM" or "HH:MM:SS" local wall-clock strings (a
// Postgres `time` column, never a timestamp — see lib/timezone.ts).
export type TimeWindow = {
  startTime: string;
  endTime: string;
};

export type WeeklyRule = TimeWindow & {
  dayOfWeek: DayOfWeek;
};

export type DateException = {
  type: "CLOSED" | "CUSTOM_HOURS";
  startTime: string | null;
  endTime: string | null;
};

export type CalculateSlotsInput = {
  date: string; // "YYYY-MM-DD"
  timezone: string; // IANA identifier
  serviceDurationMinutes: number;
  weeklyRules: WeeklyRule[]; // all of the provider's rules; filtered internally by day
  exception: DateException | null; // the exception for THIS date, if any
  now: Date; // injected "current instant" so calculation stays deterministic in tests
};

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minutesToHm(totalMinutes: number): { hour: number; minute: number } {
  return { hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60 };
}

// Windows for a CLOSED exception, a CUSTOM_HOURS exception, or (absent any
// exception) the weekly rules for that calendar date's day of week.
//
//   If a date has CLOSED:        no slots.
//   If a date has CUSTOM_HOURS:  use the exception's hours instead of the
//                                 weekly schedule (never combined with it).
//   If no exception exists:      use the weekly schedule for that weekday.
function resolveWindowsForDate(date: string, weeklyRules: WeeklyRule[], exception: DateException | null): TimeWindow[] {
  if (exception) {
    if (exception.type === "CLOSED") return [];
    // CUSTOM_HOURS — schema guarantees start/end are present for this type.
    return [{ startTime: exception.startTime!, endTime: exception.endTime! }];
  }

  const weekday = dayOfWeekForDate(date);
  return weeklyRules
    .filter((rule) => rule.dayOfWeek === weekday)
    .map((rule) => ({ startTime: rule.startTime, endTime: rule.endTime }));
}

// Pure, deterministic slot calculation. Deliberately knows nothing about
// HTTP, the database, or bookings — it only turns (schedule for this date)
// + (service duration) + ("now") into a list of valid appointment start
// instants, formatted with the provider's own UTC offset.
export function calculateAvailableSlots(input: CalculateSlotsInput): string[] {
  const { date, timezone, serviceDurationMinutes, weeklyRules, exception, now } = input;
  const windows = resolveWindowsForDate(date, weeklyRules, exception);
  const nowMs = now.getTime();

  const results: string[] = [];

  for (const window of windows) {
    const windowStartMin = parseTimeToMinutes(window.startTime);
    const windowEndMin = parseTimeToMinutes(window.endTime);

    // Each window is treated independently: a candidate slot must start
    // and (start + duration) end within THIS window — it can never
    // stretch across the gap into a different window (e.g. the lunch
    // break between 09:00–13:00 and 14:00–18:00 is never bridged).
    for (
      let slotStartMin = windowStartMin;
      slotStartMin + serviceDurationMinutes <= windowEndMin;
      slotStartMin += SLOT_INTERVAL_MINUTES
    ) {
      const { hour, minute } = minutesToHm(slotStartMin);
      const [year, month, day] = date.split("-").map(Number);
      const slotInstant = zonedTimeToUtc(year, month, day, hour, minute, timezone);

      // Excludes any slot whose start has already passed. This alone also
      // correctly excludes every slot on an entirely-past date without a
      // separate special case, since every such slot's instant is < now.
      if (slotInstant.getTime() < nowMs) continue;

      results.push(formatZonedIso(slotInstant, timezone));
    }
  }

  return results;
}
