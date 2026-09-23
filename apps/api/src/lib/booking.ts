import { createHash } from "node:crypto";
import type { BookingStatus, CreateBookingInput, PublicBooking } from "@pawlink/shared";
import { BLOCKING_BOOKING_STATUSES } from "@pawlink/shared";
import type { bookings } from "../db/schema.js";

type BookingRow = typeof bookings.$inferSelect;

export function toPublicBooking(booking: BookingRow): PublicBooking {
  return {
    id: booking.id,
    providerId: booking.providerId,
    serviceId: booking.serviceId,
    petId: booking.petId,
    startAt: booking.startAt.toISOString(),
    endAt: booking.endAt.toISOString(),
    status: booking.status,
    priceMinor: booking.priceMinor,
    currency: booking.currency,
    serviceName: booking.serviceNameSnapshot,
    serviceDurationMinutes: booking.serviceDurationMinutesSnapshot,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
  };
}

export class BookingStatusTransitionError extends Error {}

// Single authoritative transition table — see packages/shared/src/bookings.ts
// for the documented lifecycle decision. The client never supplies a
// status directly; this is only ever invoked with a next-status the
// SERVER decided on (CONFIRMED at creation, CANCELLED on cancel).
const ALLOWED_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["CANCELLED", "COMPLETED"],
  CANCELLED: [],
  COMPLETED: [],
};

export function assertBookingStatusTransition(current: BookingStatus, next: BookingStatus): void {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new BookingStatusTransitionError(`Cannot transition a booking from ${current} to ${next}`);
  }
}

const BLOCKING_STATUS_SET = new Set<BookingStatus>(BLOCKING_BOOKING_STATUSES);

export function isBlockingBookingStatus(status: BookingStatus): boolean {
  return BLOCKING_STATUS_SET.has(status);
}

export type BookingInterval = {
  startAt: Date;
  endAt: Date;
};

// Subtracts already-reserved time from a candidate slot list. This is a
// pure post-filter, not a second scheduling algorithm — the candidate
// slots themselves still come solely from calculateAvailableSlots()
// (apps/api/src/lib/availability.ts), which remains entirely unaware of
// bookings. Half-open interval overlap ([start, end)), matching the same
// convention used for weekly-window overlap checks and the database's
// own tstzrange exclusion constraint (see the migration) — a booking
// ending at 10:00 does not block a slot starting at 10:00.
// Deterministic hash of the booking parameters an Idempotency-Key was
// used with, so a replay with the SAME key can be told apart from reuse
// of that key for a materially DIFFERENT booking. Key order is fixed
// explicitly (not just JSON.stringify(input)) so the hash never depends
// on incidental object key ordering.
export function hashBookingRequest(input: CreateBookingInput): string {
  const canonical = JSON.stringify({
    providerId: input.providerId,
    serviceId: input.serviceId,
    petId: input.petId,
    startAt: input.startAt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class IdempotencyConflictError extends Error {}
export class IdempotencyRaceError extends Error {}

// Carries a specific HTTP response out of the booking transaction. Thrown
// only for conditions discovered by the AUTHORITATIVE in-transaction reads
// (provider/service/pet/availability) — never a substitute for Zod input
// validation, which still happens before the transaction opens. Throwing
// rolls the transaction back (nothing has been written yet at that point),
// and the route handler's catch block converts it back into the same
// response shape the pre-hardening code returned for each case.
export class BookingRouteError extends Error {
  constructor(
    public readonly status: 403 | 404 | 409,
    public readonly body: Record<string, unknown>,
  ) {
    super(`BookingRouteError(${status})`);
  }
}

export function excludeBookedSlots(
  candidateSlots: string[],
  serviceDurationMinutes: number,
  bookedIntervals: BookingInterval[],
): string[] {
  if (bookedIntervals.length === 0) return candidateSlots;

  return candidateSlots.filter((iso) => {
    const slotStart = new Date(iso);
    const slotEnd = new Date(slotStart.getTime() + serviceDurationMinutes * 60_000);
    return !bookedIntervals.some((b) => slotStart < b.endAt && b.startAt < slotEnd);
  });
}
