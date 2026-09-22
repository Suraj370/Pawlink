import { describe, expect, it } from "vitest";
import { dayOfWeekForDate, formatZonedIso, isValidTimeZone, zonedTimeToUtc } from "./timezone.js";

describe("isValidTimeZone", () => {
  it("accepts real IANA identifiers", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Etc/UTC")).toBe(true);
  });

  it("accepts the literal UTC", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects fixed abbreviations despite ICU aliasing them to a real zone", () => {
    // "IST" resolves via ICU's legacy alias table to Asia/Calcutta, but
    // it is exactly the ambiguous abbreviation form this must reject
    // (IST could mean India, Israel, or Ireland Standard Time).
    expect(isValidTimeZone("IST")).toBe(false);
    expect(isValidTimeZone("PST")).toBe(false);
    expect(isValidTimeZone("EST5EDT")).toBe(false);
  });

  it("rejects fixed UTC offsets", () => {
    expect(isValidTimeZone("UTC+5:30")).toBe(false);
    expect(isValidTimeZone("+05:30")).toBe(false);
  });

  it("rejects nonsense and empty input", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("   ")).toBe(false);
  });
});

describe("zonedTimeToUtc / formatZonedIso round-trip", () => {
  it("round-trips a fixed-offset zone", () => {
    const instant = zonedTimeToUtc(2026, 10, 5, 9, 0, "Asia/Kolkata");
    expect(instant.toISOString()).toBe("2026-10-05T03:30:00.000Z");
    expect(formatZonedIso(instant, "Asia/Kolkata")).toBe("2026-10-05T09:00:00+05:30");
  });

  it("resolves the correct offset either side of a DST transition", () => {
    const beforeFallback = zonedTimeToUtc(2026, 10, 5, 9, 0, "America/New_York");
    expect(formatZonedIso(beforeFallback, "America/New_York")).toBe("2026-10-05T09:00:00-04:00");

    const afterFallback = zonedTimeToUtc(2026, 11, 5, 9, 0, "America/New_York");
    expect(formatZonedIso(afterFallback, "America/New_York")).toBe("2026-11-05T09:00:00-05:00");
  });

  it("round-trips UTC itself", () => {
    const instant = zonedTimeToUtc(2026, 1, 1, 0, 0, "UTC");
    expect(formatZonedIso(instant, "UTC")).toBe("2026-01-01T00:00:00+00:00");
  });
});

describe("dayOfWeekForDate", () => {
  it("computes the weekday from the calendar date alone, independent of any timezone", () => {
    expect(dayOfWeekForDate("2026-10-05")).toBe("MONDAY");
    expect(dayOfWeekForDate("2026-10-04")).toBe("SUNDAY");
    expect(dayOfWeekForDate("2026-10-06")).toBe("TUESDAY");
  });
});
