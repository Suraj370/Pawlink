import { z } from "zod";

// Lifecycle (documented decision):
//
//   PENDING   -> CONFIRMED | CANCELLED
//   CONFIRMED -> CANCELLED | COMPLETED
//   CANCELLED, COMPLETED are terminal — no transitions out.
//
// The API currently creates every booking directly as CONFIRMED (there is
// no payment or manual-provider-approval gate yet to hold a booking in
// PENDING), so PENDING is not reachable through today's endpoints. It is
// still a fully-defined, legal state in the schema/enum/transition table
// — not a stub — because it's the natural hook for a future
// payment-hold or manual-confirmation flow, and rejecting it outright
// would be a breaking schema change later. COMPLETED is similarly a
// legal terminal transition target but nothing currently moves a booking
// into it (no automatic "appointment time has passed" job exists — see
// docs/architecture.md for why that's out of scope here).
export const BOOKING_STATUS_VALUES = ["PENDING", "CONFIRMED", "CANCELLED", "COMPLETED"] as const;
export const bookingStatusSchema = z.enum(BOOKING_STATUS_VALUES);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

// Statuses that consume provider capacity (block an overlapping booking
// from existing). CANCELLED never blocks. COMPLETED blocks too — a
// completed appointment did happen and its time range is historically
// occupied — but in practice a booking only reaches COMPLETED after its
// end time has passed, so it can never actually overlap a *future*
// candidate slot; it's included for correctness rather than because it
// changes today's behavior.
export const BLOCKING_BOOKING_STATUSES = ["PENDING", "CONFIRMED", "COMPLETED"] as const satisfies readonly BookingStatus[];

const ISO_OFFSET_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Requires an explicit timezone designator (Z or ±HH:MM) — a bare local
// time like "2026-10-05T09:00:00" is rejected rather than silently
// interpreted in some assumed timezone. See apps/api/src/lib/timezone.ts.
export const isoOffsetDateTimeSchema = z
  .string()
  .regex(ISO_OFFSET_DATETIME_RE, "startAt must be an ISO-8601 timestamp with a timezone offset (e.g. 2026-10-05T09:00:00+05:30)")
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "startAt is not a valid date/time" });

// Creation never accepts customerUserId, priceMinor, currency, endAt,
// status, or the service snapshot fields — every one of those is
// server-derived (session identity, current service row, computed
// duration). The client controls only what it's choosing.
export const createBookingSchema = z.object({
  providerId: z.string().uuid("providerId must be a valid id"),
  serviceId: z.string().uuid("serviceId must be a valid id"),
  petId: z.string().uuid("petId must be a valid id"),
  startAt: isoOffsetDateTimeSchema,
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const bookingListQuerySchema = z.object({
  providerId: z.string().uuid().optional(),
  status: bookingStatusSchema.optional(),
  when: z.enum(["upcoming", "past"]).optional(),
  page: z.coerce.number().int().positive().catch(1),
  pageSize: z.coerce.number().int().positive().max(50).catch(20),
});
export type BookingListQuery = z.infer<typeof bookingListQuerySchema>;

// Never a raw database row. priceMinor/currency/serviceName/
// serviceDurationMinutes are the SNAPSHOT taken at booking creation —
// they intentionally do not reflect any later change to the service.
export const publicBookingSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  serviceId: z.string(),
  petId: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  status: bookingStatusSchema,
  priceMinor: z.number(),
  currency: z.string(),
  serviceName: z.string(),
  serviceDurationMinutes: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicBooking = z.infer<typeof publicBookingSchema>;

export const bookingListResponseSchema = z.object({
  bookings: z.array(publicBookingSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});
export type BookingListResponse = z.infer<typeof bookingListResponseSchema>;
