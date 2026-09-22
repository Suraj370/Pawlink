// Deliberate date/time model:
//
// - A provider's weekly hours and date exceptions are stored as LOCAL wall
//   clock values (a Postgres `time`/`date`, never a `timestamp`) — "9 AM to
//   5 PM" means the same wall-clock hours every day regardless of DST, which
//   is what a recurring weekly schedule actually means to a business owner.
// - Converting a (date, local time-of-day, IANA timezone) triple to an
//   absolute UTC instant is the one place DST/offset math happens, and it
//   happens per-slot (see lib/availability.ts) rather than once per day, so
//   a DST transition in the middle of a provider's business hours is
//   handled correctly for every individual slot.
// - No third-party date library is introduced: Node's built-in `Intl` with
//   an explicit `timeZone` is sufficient and is the standard technique
//   (the same one date-fns-tz/luxon use internally) for IANA-correct
//   conversions without adding a dependency.
//
// isValidTimeZone lives in packages/shared (Intl is equally standard in
// browsers), so client and server validation can never diverge — it's
// re-exported here rather than duplicated.
export { isValidTimeZone } from "@pawlink/shared";

const OFFSET_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = OFFSET_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    OFFSET_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsAt(utcMs: number, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

// The UTC offset (in minutes, e.g. +330 for IST) that `timeZone` observes
// at the given UTC instant — correctly reflects DST for that instant.
function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const p = partsAt(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - utcMs) / 60_000;
}

// Converts a local wall-clock date+time in `timeZone` to an absolute UTC
// instant. Two-pass: an initial guess (treat the local time as if it were
// UTC), then re-derive the offset at that guessed instant and correct —
// this is exact except in the (unhandled, and vanishingly rare for a
// business's opening hours) case of a wall-clock time that falls in a
// DST "spring forward" gap that never occurs at all.
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = offsetMinutesAt(guessUtcMs, timeZone);
  const refinedUtcMs = guessUtcMs - offset1 * 60_000;
  const offset2 = offsetMinutesAt(refinedUtcMs, timeZone);
  const finalUtcMs = offset2 === offset1 ? refinedUtcMs : guessUtcMs - offset2 * 60_000;
  return new Date(finalUtcMs);
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Formats a UTC instant as an ISO-8601 string carrying the *provider's*
// UTC offset (e.g. "2026-10-05T09:00:00+05:30"), never a literal "Z" —
// the offset is what makes the wall-clock meaning of the timestamp
// unambiguous to a client without it having to know the provider's zone.
export function formatZonedIso(date: Date, timeZone: string): string {
  const utcMs = date.getTime();
  const p = partsAt(utcMs, timeZone);
  const offsetMinutes = offsetMinutesAt(utcMs, timeZone);
  return (
    `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}` +
    formatOffset(offsetMinutes)
  );
}

// The calendar date (in `timeZone`) that a UTC instant falls on — the
// inverse of the date-selection half of zonedTimeToUtc. Used when
// re-validating a client-submitted booking instant: which weekly
// rule/exception date does this instant actually correspond to in the
// *provider's* timezone, not the server's or the client's.
export function zonedDateString(date: Date, timeZone: string): string {
  const p = partsAt(date.getTime(), timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

const DAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

// The day of the week for a calendar date (e.g. "2026-10-05" -> "MONDAY")
// is a property of the calendar date alone — it does not depend on any
// timezone. Using UTC-based Date methods on a UTC-constructed instant
// avoids ever contaminating this with the server's local timezone.
export function dayOfWeekForDate(isoDate: string): (typeof DAY_NAMES)[number] {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utcMs = Date.UTC(year, month - 1, day);
  return DAY_NAMES[new Date(utcMs).getUTCDay()];
}
