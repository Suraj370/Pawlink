import { and, eq, inArray } from "drizzle-orm";
import type { PublicMedicalRecord } from "@pawlink/shared";
import type { DbClient } from "../db/client.js";
import { bookings, medicalRecords, providers } from "../db/schema.js";

type MedicalRecordRow = typeof medicalRecords.$inferSelect;

export function toPublicMedicalRecord(record: MedicalRecordRow, providerName: string): PublicMedicalRecord {
  return {
    id: record.id,
    petId: record.petId,
    providerId: record.providerId,
    providerName,
    bookingId: record.bookingId,
    recordType: record.recordType,
    title: record.title,
    description: record.description,
    details: (record.details ?? {}) as Record<string, unknown>,
    recordedAt: record.recordedAt.toISOString(),
    status: record.status,
    archivedAt: record.archivedAt ? record.archivedAt.toISOString() : null,
    archivedReason: record.archivedReason,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

// A booking counts as establishing a "legitimate relationship" only once
// it represents a real, confirmed appointment — never PENDING (payment
// not yet settled; the provider may never actually see this pet) and
// never CANCELLED. See docs/architecture.md, "Medical records — provider
// access model," for the full rationale and the deliberate choice to use
// the SAME rule for both read and write access.
const LEGITIMATE_RELATIONSHIP_STATUSES = ["CONFIRMED", "COMPLETED"] as const;

// The single source of truth for "which of this user's own provider
// businesses have a legitimate relationship with this pet." Never derived
// from anything the client supplies (a providerId in a request body is,
// at most, checked for membership in this list — see
// routes/medical-records.ts) — always recomputed here from the
// authenticated user's id and real booking rows.
export async function findAuthorizedProviderIds(
  queryable: Pick<DbClient, "select">,
  params: { userId: string; petId: string },
): Promise<string[]> {
  const rows = await queryable
    .select({ providerId: providers.id })
    .from(providers)
    .innerJoin(bookings, eq(bookings.providerId, providers.id))
    .where(
      and(
        eq(providers.ownerUserId, params.userId),
        eq(bookings.petId, params.petId),
        inArray(bookings.status, [...LEGITIMATE_RELATIONSHIP_STATUSES]),
      ),
    )
    .groupBy(providers.id);
  return rows.map((r) => r.providerId);
}

export class MedicalRecordBookingError extends Error {}

// Validates a client-supplied bookingId against EVERY relationship it
// claims, never trusting any single field in isolation — this is the
// direct defense against "Provider A + Pet B + Booking C belonging to
// Provider C" (see the milestone brief, section 11). Returns the booking
// row on success or throws MedicalRecordBookingError with a message safe
// to surface to the caller (it never confirms whether a booking exists
// for someone else — every failure mode reads identically).
export async function loadLegitimateBooking(
  queryable: Pick<DbClient, "query">,
  params: { bookingId: string; petId: string; providerId: string },
) {
  const booking = await queryable.query.bookings.findFirst({ where: eq(bookings.id, params.bookingId) });
  if (
    !booking ||
    booking.petId !== params.petId ||
    booking.providerId !== params.providerId ||
    !LEGITIMATE_RELATIONSHIP_STATUSES.includes(booking.status as (typeof LEGITIMATE_RELATIONSHIP_STATUSES)[number])
  ) {
    throw new MedicalRecordBookingError("bookingId does not refer to a valid, confirmed booking for this pet and provider");
  }
  return booking;
}
