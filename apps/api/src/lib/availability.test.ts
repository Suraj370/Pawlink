import { describe, expect, it } from "vitest";
import { SLOT_INTERVAL_MINUTES, calculateAvailableSlots, type WeeklyRule } from "./availability.js";

// A fixed "now" far in the past relative to every test date below, so
// none of these tests are accidentally exercising the past-slot filter
// unless a test explicitly sets `now` to something else.
const FAR_PAST = new Date("2000-01-01T00:00:00Z");

function mondayFridayNineToFive(): WeeklyRule[] {
  return (["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const).map((dayOfWeek) => ({
    dayOfWeek,
    startTime: "09:00",
    endTime: "17:00",
  }));
}

describe("calculateAvailableSlots — weekly schedule", () => {
  it("generates 30-minute-interval slots for a Monday within a 60-minute service window", () => {
    // 2026-10-05 is a Monday.
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 60,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "12:00" }],
      exception: null,
      now: FAR_PAST,
    });
    expect(slots).toEqual([
      "2026-10-05T09:00:00+00:00",
      "2026-10-05T09:30:00+00:00",
      "2026-10-05T10:00:00+00:00",
      "2026-10-05T10:30:00+00:00",
      "2026-10-05T11:00:00+00:00",
    ]);
    // The task's worked example explicitly excludes 11:30 (would finish at
    // 12:30, past the 12:00 window end).
    expect(slots).not.toContain("2026-10-05T11:30:00+00:00");
  });

  it("uses the matching weekday's rule (Tuesday differs from Monday)", () => {
    const rules: WeeklyRule[] = [
      { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "10:00" },
      { dayOfWeek: "TUESDAY", startTime: "13:00", endTime: "14:00" },
    ];
    // 2026-10-06 is a Tuesday.
    const slots = calculateAvailableSlots({
      date: "2026-10-06",
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: rules,
      exception: null,
      now: FAR_PAST,
    });
    expect(slots).toEqual(["2026-10-06T13:00:00+00:00", "2026-10-06T13:30:00+00:00"]);
  });

  it("returns no slots for a day with no weekly rule (closed Sunday)", () => {
    // 2026-10-04 is a Sunday; only Mon-Fri rules exist.
    const slots = calculateAvailableSlots({
      date: "2026-10-04",
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: mondayFridayNineToFive(),
      exception: null,
      now: FAR_PAST,
    });
    expect(slots).toEqual([]);
  });

  it("treats multiple windows on the same day independently and never bridges the gap", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05", // Monday
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: [
        { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "13:00" },
        { dayOfWeek: "MONDAY", startTime: "14:00", endTime: "18:00" },
      ],
      exception: null,
      now: FAR_PAST,
    });
    // 12:30 is a valid 30-min slot in the first window.
    expect(slots).toContain("2026-10-05T12:30:00+00:00");
    // But nothing bridges into the 13:00-14:00 closed gap.
    expect(slots).not.toContain("2026-10-05T13:00:00+00:00");
    expect(slots).not.toContain("2026-10-05T13:30:00+00:00");
    // The second window starts cleanly at 14:00.
    expect(slots).toContain("2026-10-05T14:00:00+00:00");
  });

  it("a 90-minute service does not fit where a 60-minute one would", () => {
    const rules: WeeklyRule[] = [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "12:00" }];
    const with90 = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 90,
      weeklyRules: rules,
      exception: null,
      now: FAR_PAST,
    });
    // Last slot that fits 90 minutes in a window ending at 12:00 is 10:30
    // (10:30 + 90 = 12:00); 11:00 would finish at 12:30.
    expect(with90).toEqual(["2026-10-05T09:00:00+00:00", "2026-10-05T09:30:00+00:00", "2026-10-05T10:00:00+00:00", "2026-10-05T10:30:00+00:00"]);
    expect(with90).not.toContain("2026-10-05T11:00:00+00:00");
  });

  it("a 30-minute service (matching the slot interval) fills every step", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "10:00" }],
      exception: null,
      now: FAR_PAST,
    });
    expect(slots).toEqual(["2026-10-05T09:00:00+00:00", "2026-10-05T09:30:00+00:00"]);
  });
});

describe("calculateAvailableSlots — boundary conditions", () => {
  it("includes a slot exactly at opening", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "09:30" }],
      exception: null,
      now: FAR_PAST,
    });
    expect(slots).toEqual(["2026-10-05T09:00:00+00:00"]);
  });

  it("a service that fits the window exactly (ends exactly at closing) is included", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 60,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "10:00" }],
      exception: null,
      now: FAR_PAST,
    });
    expect(slots).toEqual(["2026-10-05T09:00:00+00:00"]);
  });

  it("a service that would end one interval after closing is excluded", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 60,
      // Window is only 30 minutes; a 60-minute service can never fit.
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "09:30" }],
      exception: null,
      now: FAR_PAST,
    });
    expect(slots).toEqual([]);
  });

  it("service exactly the length of the window produces exactly one slot", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 180,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "12:00" }],
      exception: null,
      now: FAR_PAST,
    });
    expect(slots).toEqual(["2026-10-05T09:00:00+00:00"]);
  });

  it("a zero-width window produces no slots", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "09:00" }],
      exception: null,
      now: FAR_PAST,
    });
    expect(slots).toEqual([]);
  });
});

describe("calculateAvailableSlots — past-slot filtering", () => {
  it("excludes slots on the current date whose start has already passed, in the provider's timezone", () => {
    // "now" is 09:15 IST on 2026-10-05 — the 09:00 IST slot has passed,
    // 09:30 has not.
    const now = new Date("2026-10-05T03:45:00Z"); // 03:45 UTC == 09:15 IST
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "Asia/Kolkata",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "11:00" }],
      exception: null,
      now,
    });
    expect(slots).not.toContain("2026-10-05T09:00:00+05:30");
    expect(slots).toContain("2026-10-05T09:30:00+05:30");
  });

  it("returns no slots at all for a date that is entirely in the past", () => {
    const now = new Date("2026-10-10T00:00:00Z");
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }],
      exception: null,
      now,
    });
    expect(slots).toEqual([]);
  });

  it("generates the full schedule for a future date regardless of the current time of day", () => {
    const now = new Date("2026-10-05T23:00:00Z"); // late in the day, but the target date is later
    const slots = calculateAvailableSlots({
      date: "2026-10-12",
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "10:00" }],
      exception: null,
      now,
    });
    expect(slots).toEqual(["2026-10-12T09:00:00+00:00", "2026-10-12T09:30:00+00:00"]);
  });
});

describe("calculateAvailableSlots — timezone correctness", () => {
  it("produces the same wall-clock slots with the correct offset for a non-UTC timezone", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "Asia/Kolkata",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "10:00" }],
      exception: null,
      now: FAR_PAST,
    });
    expect(slots).toEqual(["2026-10-05T09:00:00+05:30", "2026-10-05T09:30:00+05:30"]);
  });

  it("does not shift the calendar date across a timezone boundary", () => {
    // A timezone far ahead of UTC (Pacific/Kiritimati, UTC+14) requesting
    // the morning must still report the date as given, not the UTC date.
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "Pacific/Kiritimati",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "10:00" }],
      exception: null,
      now: FAR_PAST,
    });
    expect(slots[0]).toMatch(/^2026-10-05T09:00:00\+14:00$/);
  });

  it("resolves the correct offset either side of a DST transition", () => {
    // US DST ends 2026-11-01. 2026-10-05 is EDT (-04:00); 2026-11-02 (the
    // Monday right after the fallback) is EST (-05:00).
    const rules: WeeklyRule[] = [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "10:00" }];
    const beforeFallback = calculateAvailableSlots({
      date: "2026-10-05", // Monday, EDT
      timezone: "America/New_York",
      serviceDurationMinutes: 30,
      weeklyRules: rules,
      exception: null,
      now: FAR_PAST,
    });
    expect(beforeFallback[0]).toBe("2026-10-05T09:00:00-04:00");

    const afterFallback = calculateAvailableSlots({
      date: "2026-11-02", // Monday, after the Nov 1 fallback, EST
      timezone: "America/New_York",
      serviceDurationMinutes: 30,
      weeklyRules: rules,
      exception: null,
      now: FAR_PAST,
    });
    expect(afterFallback[0]).toBe("2026-11-02T09:00:00-05:00");
  });
});

describe("calculateAvailableSlots — exceptions", () => {
  it("CLOSED exception overrides the weekly schedule entirely", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05", // would normally be open per the weekly rule
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }],
      exception: { type: "CLOSED", startTime: null, endTime: null },
      now: FAR_PAST,
    });
    expect(slots).toEqual([]);
  });

  it("CUSTOM_HOURS exception replaces (not adds to) the weekly schedule", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }],
      exception: { type: "CUSTOM_HOURS", startTime: "10:00", endTime: "15:00" },
      now: FAR_PAST,
    });
    // Nothing from the weekly 09:00 hour leaks in.
    expect(slots).not.toContain("2026-10-05T09:00:00+00:00");
    expect(slots).not.toContain("2026-10-05T09:30:00+00:00");
    // The custom window's own bounds are respected.
    expect(slots[0]).toBe("2026-10-05T10:00:00+00:00");
    expect(slots.at(-1)).toBe("2026-10-05T14:30:00+00:00");
  });

  it("no exception falls back to the weekly schedule", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "10:00" }],
      exception: null,
      now: FAR_PAST,
    });
    expect(slots).toEqual(["2026-10-05T09:00:00+00:00", "2026-10-05T09:30:00+00:00"]);
  });
});

describe("calculateAvailableSlots — invariants", () => {
  // "No returned slots may overlap" (task's invariant list) is
  // interpreted, consistent with the explicit worked example in section
  // 14 of the spec (which shows 09:00/09:30/10:00/10:30/11:00 as correct
  // output for a 60-minute service at a 30-minute interval — those
  // *appointment spans* clearly overlap by design, since only one will
  // ever actually be booked), as: no slot may cross a window boundary
  // into a closed period, and no duplicate slot appears twice.
  it("every slot starts within its window and finishes by the window end, with no duplicates", () => {
    const windows = [
      { startTime: "09:00", endTime: "13:00" },
      { startTime: "14:00", endTime: "18:00" },
    ];
    const rules: WeeklyRule[] = windows.map((w) => ({ dayOfWeek: "MONDAY", ...w }));
    const duration = 45;
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: duration,
      weeklyRules: rules,
      exception: null,
      now: FAR_PAST,
    });

    expect(new Set(slots).size).toBe(slots.length); // no duplicates

    for (const iso of slots) {
      const [, timePart] = iso.split("T");
      const [h, m] = timePart.split(":").map(Number);
      const startMin = h * 60 + m;
      const endMin = startMin + duration;

      const containingWindow = windows.find((w) => {
        const [wsH, wsM] = w.startTime.split(":").map(Number);
        const [weH, weM] = w.endTime.split(":").map(Number);
        return startMin >= wsH * 60 + wsM && endMin <= weH * 60 + weM;
      });
      expect(containingWindow, `slot ${iso} must fit entirely within a single window`).toBeDefined();
    }
  });

  it("every slot belongs to the requested calendar date, never the day before or after", () => {
    // A timezone offset far enough from UTC that a naive implementation
    // could plausibly shift the date.
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "Pacific/Kiritimati", // UTC+14
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "23:00", endTime: "23:30" }],
      exception: null,
      now: FAR_PAST,
    });
    for (const iso of slots) {
      expect(iso.startsWith("2026-10-05T")).toBe(true);
    }
  });

  it("the configured slot interval is respected between consecutive slots in the same window", () => {
    const slots = calculateAvailableSlots({
      date: "2026-10-05",
      timezone: "UTC",
      serviceDurationMinutes: 30,
      weeklyRules: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "11:00" }],
      exception: null,
      now: FAR_PAST,
    });
    for (let i = 1; i < slots.length; i++) {
      const prevMin = Number(slots[i - 1].slice(11, 13)) * 60 + Number(slots[i - 1].slice(14, 16));
      const curMin = Number(slots[i].slice(11, 13)) * 60 + Number(slots[i].slice(14, 16));
      expect(curMin - prevMin).toBe(SLOT_INTERVAL_MINUTES);
    }
  });
});
