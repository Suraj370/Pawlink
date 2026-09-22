import { Hono } from "hono";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { BLOCKING_BOOKING_STATUSES, bookingListQuerySchema, createBookingSchema } from "@pawlink/shared";
import type { AppEnv } from "../types.js";
import type { DbClient } from "../db/client.js";
import { availabilityExceptions, bookingIdempotencyKeys, bookings, pets, providerAvailability, providers, services } from "../db/schema.js";
import { calculateAvailableSlots } from "../lib/availability.js";
import {
  assertBookingStatusTransition,
  BookingStatusTransitionError,
  excludeBookedSlots,
  hashBookingRequest,
  IdempotencyConflictError,
  IdempotencyRaceError,
  toPublicBooking,
} from "../lib/booking.js";
import { formatZonedIso, zonedDateString } from "../lib/timezone.js";
import { createRequireAuth } from "../middleware/auth.js";

const uuidSchema = z.string().uuid();

const PROVIDER_NOT_FOUND = { error: "Provider not found" } as const;
const SERVICE_NOT_FOUND = { error: "Service not found" } as const;
const PET_NOT_FOUND = { error: "Pet not found" } as const;
const BOOKING_NOT_FOUND = { error: "Booking not found" } as const;

const EXCLUSION_VIOLATION = "23P01";
function isExclusionViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === EXCLUSION_VIOLATION;
}

export function createBookingRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);

  app.use("*", requireAuth);

  async function loadProviderForBooking(booking: { providerId: string }, userId: string, userRole: string) {
    const provider = await db.query.providers.findFirst({ where: eq(providers.id, booking.providerId) });
    return !!provider && (provider.ownerUserId === userId || userRole === "ADMIN");
  }

  // -----------------------------------------------------------------------
  // POST / — create a booking. Availability is only ever advisory; every
  // check the availability endpoint makes is re-verified here, server-side,
  // against the live database, inside the same transaction that performs
  // the reservation.
  // -----------------------------------------------------------------------
  app.post("/", async (c) => {
    const user = c.get("user");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = createBookingSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }
    const { providerId, serviceId, petId, startAt } = parsed.data;
    const idempotencyKey = c.req.header("Idempotency-Key");

    const provider = await db.query.providers.findFirst({ where: eq(providers.id, providerId) });
    if (!provider) return c.json(PROVIDER_NOT_FOUND, 404);
    if (provider.status !== "ACTIVE") {
      return c.json({ error: "This provider is not currently accepting bookings" }, 409);
    }

    const service = await db.query.services.findFirst({
      where: and(eq(services.id, serviceId), eq(services.providerId, providerId)),
    });
    if (!service) return c.json(SERVICE_NOT_FOUND, 404);
    if (!service.active) {
      return c.json({ error: "This service is no longer available" }, 409);
    }

    // Ownership is derived from the session, never a client-supplied
    // customerUserId — createBookingSchema has no such field. A pet that
    // exists but belongs to someone else returns the same 404 as a
    // nonexistent one (the established IDOR-hiding convention).
    const pet = await db.query.pets.findFirst({ where: eq(pets.id, petId) });
    if (!pet || pet.ownerId !== user.id) {
      return c.json(PET_NOT_FOUND, 404);
    }

    const requestedInstant = new Date(startAt);
    const requestHash = idempotencyKey ? hashBookingRequest(parsed.data) : null;

    // Idempotency is checked BEFORE availability re-validation, not after
    // — a legitimate replay of a request that already succeeded would
    // otherwise be rejected by the availability check below, since the
    // booking IT created is now (correctly) occupying that exact slot.
    // This is a plain read, not yet the transactional claim: a genuinely
    // concurrent duplicate can still slip past it, which is fine, because
    // the transactional insert-with-onConflictDoNothing further down
    // remains the actual source of truth for concurrent-same-key
    // convergence (see the "concurrent requests" test) — this is purely
    // what makes a *sequential* replay correct.
    if (idempotencyKey) {
      const existingClaim = await db.query.bookingIdempotencyKeys.findFirst({
        where: and(eq(bookingIdempotencyKeys.customerUserId, user.id), eq(bookingIdempotencyKeys.key, idempotencyKey)),
      });
      if (existingClaim && existingClaim.bookingId !== null) {
        if (existingClaim.requestHash !== requestHash) {
          return c.json({ error: "Idempotency-Key was already used with different booking parameters" }, 409);
        }
        const existingBooking = await db.query.bookings.findFirst({ where: eq(bookings.id, existingClaim.bookingId) });
        if (existingBooking) {
          return c.json({ booking: toPublicBooking(existingBooking) }, 200);
        }
      }
    }

    // Re-validate the requested instant against the SAME algorithm the
    // public availability endpoint uses — not a second implementation of
    // "what's a legal slot." This alone enforces slot-interval alignment,
    // full-duration-fits-in-window, exception precedence, and
    // not-in-the-past, all in one reused call.
    const candidateDate = zonedDateString(requestedInstant, provider.timezone);
    const weeklyRules = await db.query.providerAvailability.findMany({
      where: eq(providerAvailability.providerId, provider.id),
    });
    const exceptionRow = await db.query.availabilityExceptions.findFirst({
      where: and(eq(availabilityExceptions.providerId, provider.id), eq(availabilityExceptions.date, candidateDate)),
    });
    const candidateSlots = calculateAvailableSlots({
      date: candidateDate,
      timezone: provider.timezone,
      serviceDurationMinutes: service.durationMinutes,
      weeklyRules: weeklyRules.map((r) => ({ dayOfWeek: r.dayOfWeek, startTime: r.startTime, endTime: r.endTime })),
      exception: exceptionRow
        ? { type: exceptionRow.type, startTime: exceptionRow.startTime, endTime: exceptionRow.endTime }
        : null,
      now: new Date(),
    });

    // Slots already consumed by another active booking for this provider
    // (any service — the same provider can't be in two appointments at
    // once) must also be excluded before checking membership.
    const activeBookings = await db.query.bookings.findMany({
      where: and(eq(bookings.providerId, provider.id), inArray(bookings.status, [...BLOCKING_BOOKING_STATUSES])),
    });
    const availableSlots = excludeBookedSlots(
      candidateSlots,
      service.durationMinutes,
      activeBookings.map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
    );

    const requestedIso = formatZonedIso(requestedInstant, provider.timezone);
    if (!availableSlots.includes(requestedIso)) {
      return c.json({ error: "This time slot is not available" }, 409);
    }

    const endAt = new Date(requestedInstant.getTime() + service.durationMinutes * 60_000);

    try {
      const result = await db.transaction(async (tx) => {
        if (idempotencyKey) {
          const [claimed] = await tx
            .insert(bookingIdempotencyKeys)
            .values({ customerUserId: user.id, key: idempotencyKey, requestHash: requestHash!, bookingId: null })
            .onConflictDoNothing()
            .returning();

          if (!claimed) {
            // Another request already holds this key. If it was still
            // in-flight, Postgres's row lock on the unique index made us
            // wait right here until it committed or rolled back — so by
            // the time we reach this line, its outcome is already final.
            const existing = await tx.query.bookingIdempotencyKeys.findFirst({
              where: and(eq(bookingIdempotencyKeys.customerUserId, user.id), eq(bookingIdempotencyKeys.key, idempotencyKey)),
            });
            if (!existing || existing.bookingId === null) {
              // Unreachable under correct transactional use (the row that
              // blocked us either committed with a booking id or rolled
              // back entirely) — handled defensively rather than assumed.
              throw new IdempotencyRaceError();
            }
            if (existing.requestHash !== requestHash) {
              throw new IdempotencyConflictError();
            }
            const existingBooking = await tx.query.bookings.findFirst({ where: eq(bookings.id, existing.bookingId) });
            if (!existingBooking) throw new IdempotencyRaceError();
            return { booking: existingBooking, replay: true };
          }
        }

        const [inserted] = await tx
          .insert(bookings)
          .values({
            customerUserId: user.id,
            providerId: provider.id,
            serviceId: service.id,
            petId: pet.id,
            startAt: requestedInstant,
            endAt,
            status: "CONFIRMED",
            priceMinor: service.priceMinor,
            currency: service.currency,
            serviceNameSnapshot: service.name,
            serviceDurationMinutesSnapshot: service.durationMinutes,
          })
          .returning();

        if (idempotencyKey) {
          await tx
            .update(bookingIdempotencyKeys)
            .set({ bookingId: inserted.id })
            .where(and(eq(bookingIdempotencyKeys.customerUserId, user.id), eq(bookingIdempotencyKeys.key, idempotencyKey)));
        }

        return { booking: inserted, replay: false };
      });

      return c.json({ booking: toPublicBooking(result.booking) }, result.replay ? 200 : 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return c.json({ error: "Idempotency-Key was already used with different booking parameters" }, 409);
      }
      if (err instanceof IdempotencyRaceError) {
        return c.json({ error: "Another request with the same Idempotency-Key is in progress; please retry" }, 409);
      }
      if (isExclusionViolation(err)) {
        // The database is the final authority: even though we checked
        // availability above, another request could have won the race
        // between that check and this insert. The exclusion constraint
        // (see the migration) makes that impossible to miss.
        return c.json({ error: "This time slot was just booked by someone else" }, 409);
      }
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // GET / — the caller's own bookings as a customer, or (with ?providerId=)
  // a provider owner's/admin's view of bookings for that provider.
  // -----------------------------------------------------------------------
  app.get("/", async (c) => {
    const user = c.get("user");
    const parsedQuery = bookingListQuerySchema.safeParse({
      providerId: c.req.query("providerId") || undefined,
      status: c.req.query("status") || undefined,
      when: c.req.query("when") || undefined,
      page: c.req.query("page") ?? undefined,
      pageSize: c.req.query("pageSize") ?? undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: "Invalid query", fields: parsedQuery.error.flatten().fieldErrors }, 400);
    }
    const { providerId, status, when, page, pageSize } = parsedQuery.data;

    const conditions = [];
    if (providerId) {
      const provider = await db.query.providers.findFirst({ where: eq(providers.id, providerId) });
      if (!provider) return c.json(PROVIDER_NOT_FOUND, 404);
      if (provider.ownerUserId !== user.id && user.role !== "ADMIN") {
        return c.json(PROVIDER_NOT_FOUND, 404);
      }
      conditions.push(eq(bookings.providerId, providerId));
    } else {
      conditions.push(eq(bookings.customerUserId, user.id));
    }
    if (status) conditions.push(eq(bookings.status, status));
    if (when === "upcoming") conditions.push(gte(bookings.startAt, new Date()));
    if (when === "past") conditions.push(lt(bookings.startAt, new Date()));
    const where = and(...conditions);

    const [rows, totalResult] = await Promise.all([
      db.query.bookings.findMany({
        where,
        orderBy: (b, { desc }) => [desc(b.startAt)],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      db.select({ count: sql<number>`count(*)::int` }).from(bookings).where(where),
    ]);

    return c.json(
      { bookings: rows.map(toPublicBooking), page, pageSize, total: totalResult[0]?.count ?? 0 },
      200,
    );
  });

  // -----------------------------------------------------------------------
  // GET /:id — the booking's own customer, the owning provider's owner, or
  // an admin. Anyone else gets the same 404 a nonexistent id would.
  // -----------------------------------------------------------------------
  app.get("/:id", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid booking id" }, 400);

    const user = c.get("user");
    const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, idResult.data) });
    if (!booking) return c.json(BOOKING_NOT_FOUND, 404);

    const isCustomer = booking.customerUserId === user.id;
    const isProviderOwner = isCustomer ? false : await loadProviderForBooking(booking, user.id, user.role);
    if (!isCustomer && !isProviderOwner) {
      return c.json(BOOKING_NOT_FOUND, 404);
    }

    return c.json({ booking: toPublicBooking(booking) }, 200);
  });

  // -----------------------------------------------------------------------
  // POST /:id/cancel — the booking's own customer or the owning provider's
  // owner (or an admin) may cancel. Bookings are never hard-deleted —
  // cancellation only changes status, subject to the same state machine
  // used everywhere else.
  // -----------------------------------------------------------------------
  app.post("/:id/cancel", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid booking id" }, 400);

    const user = c.get("user");
    const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, idResult.data) });
    if (!booking) return c.json(BOOKING_NOT_FOUND, 404);

    const isCustomer = booking.customerUserId === user.id;
    const isProviderOwner = isCustomer ? false : await loadProviderForBooking(booking, user.id, user.role);
    if (!isCustomer && !isProviderOwner) {
      return c.json(BOOKING_NOT_FOUND, 404);
    }

    try {
      assertBookingStatusTransition(booking.status, "CANCELLED");
    } catch (err) {
      if (err instanceof BookingStatusTransitionError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }

    const [updated] = await db
      .update(bookings)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(eq(bookings.id, idResult.data))
      .returning();

    return c.json({ booking: toPublicBooking(updated) }, 200);
  });

  return app;
}
