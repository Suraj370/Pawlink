import { describe, expect, it } from "vitest";
import {
  assertBookingStatusTransition,
  BookingStatusTransitionError,
  excludeBookedSlots,
  hashBookingRequest,
  isBlockingBookingStatus,
} from "./booking.js";
import type { BookingStatus } from "@pawlink/shared";

describe("assertBookingStatusTransition", () => {
  const valid: Array<[BookingStatus, BookingStatus]> = [
    ["PENDING", "CONFIRMED"],
    ["PENDING", "CANCELLED"],
    ["CONFIRMED", "CANCELLED"],
    ["CONFIRMED", "COMPLETED"],
  ];

  it.each(valid)("allows %s -> %s", (from, to) => {
    expect(() => assertBookingStatusTransition(from, to)).not.toThrow();
  });

  const invalid: Array<[BookingStatus, BookingStatus]> = [
    ["CANCELLED", "CONFIRMED"],
    ["CANCELLED", "PENDING"],
    ["CANCELLED", "COMPLETED"],
    ["COMPLETED", "CONFIRMED"],
    ["COMPLETED", "CANCELLED"],
    ["COMPLETED", "PENDING"],
    ["CONFIRMED", "PENDING"],
    ["PENDING", "PENDING"],
    ["CONFIRMED", "CONFIRMED"],
    ["CANCELLED", "CANCELLED"],
  ];

  it.each(invalid)("rejects %s -> %s", (from, to) => {
    expect(() => assertBookingStatusTransition(from, to)).toThrow(BookingStatusTransitionError);
  });
});

describe("isBlockingBookingStatus", () => {
  it("PENDING, CONFIRMED, and COMPLETED block capacity", () => {
    expect(isBlockingBookingStatus("PENDING")).toBe(true);
    expect(isBlockingBookingStatus("CONFIRMED")).toBe(true);
    expect(isBlockingBookingStatus("COMPLETED")).toBe(true);
  });

  it("CANCELLED does not block capacity", () => {
    expect(isBlockingBookingStatus("CANCELLED")).toBe(false);
  });
});

describe("excludeBookedSlots", () => {
  const duration = 30;

  it("returns all candidates unchanged when there are no bookings", () => {
    const candidates = ["2026-10-05T09:00:00+00:00", "2026-10-05T09:30:00+00:00"];
    expect(excludeBookedSlots(candidates, duration, [])).toEqual(candidates);
  });

  it("removes a candidate slot that exactly matches a booked interval", () => {
    const candidates = ["2026-10-05T09:00:00+00:00", "2026-10-05T09:30:00+00:00"];
    const booked = [{ startAt: new Date("2026-10-05T09:00:00Z"), endAt: new Date("2026-10-05T09:30:00Z") }];
    expect(excludeBookedSlots(candidates, duration, booked)).toEqual(["2026-10-05T09:30:00+00:00"]);
  });

  it("removes a candidate slot that partially overlaps a booking", () => {
    // Candidate 09:15-09:45 (30 min) overlaps a 09:00-09:30 booking.
    const candidates = ["2026-10-05T09:15:00+00:00"];
    const booked = [{ startAt: new Date("2026-10-05T09:00:00Z"), endAt: new Date("2026-10-05T09:30:00Z") }];
    expect(excludeBookedSlots(candidates, duration, booked)).toEqual([]);
  });

  it("keeps a candidate slot that starts exactly when a booking ends (back-to-back)", () => {
    const candidates = ["2026-10-05T09:30:00+00:00"];
    const booked = [{ startAt: new Date("2026-10-05T09:00:00Z"), endAt: new Date("2026-10-05T09:30:00Z") }];
    expect(excludeBookedSlots(candidates, duration, booked)).toEqual(candidates);
  });

  it("keeps a candidate slot that ends exactly when a booking starts (back-to-back)", () => {
    const candidates = ["2026-10-05T08:30:00+00:00"];
    const booked = [{ startAt: new Date("2026-10-05T09:00:00Z"), endAt: new Date("2026-10-05T09:30:00Z") }];
    expect(excludeBookedSlots(candidates, duration, booked)).toEqual(candidates);
  });

  it("excludes a slot that overlaps any one of several bookings", () => {
    const candidates = ["2026-10-05T09:00:00+00:00", "2026-10-05T10:00:00+00:00", "2026-10-05T11:00:00+00:00"];
    const booked = [
      { startAt: new Date("2026-10-05T09:00:00Z"), endAt: new Date("2026-10-05T09:30:00Z") },
      { startAt: new Date("2026-10-05T11:00:00Z"), endAt: new Date("2026-10-05T11:30:00Z") },
    ];
    expect(excludeBookedSlots(candidates, duration, booked)).toEqual(["2026-10-05T10:00:00+00:00"]);
  });
});

describe("hashBookingRequest", () => {
  const input = {
    providerId: "11111111-1111-1111-1111-111111111111",
    serviceId: "22222222-2222-2222-2222-222222222222",
    petId: "33333333-3333-3333-3333-333333333333",
    startAt: "2026-10-05T09:00:00+05:30",
  };

  it("is deterministic for the same input", () => {
    expect(hashBookingRequest(input)).toBe(hashBookingRequest({ ...input }));
  });

  it("differs when any field differs", () => {
    const base = hashBookingRequest(input);
    expect(hashBookingRequest({ ...input, startAt: "2026-10-05T09:30:00+05:30" })).not.toBe(base);
    expect(hashBookingRequest({ ...input, petId: "44444444-4444-4444-4444-444444444444" })).not.toBe(base);
  });
});
