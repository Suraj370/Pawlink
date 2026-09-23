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
  BookingRouteError,
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

  // Accepts either the outer `db` or an open transaction `tx` — both share
  // the same relational query surface — so callers that need this check to
  // participate in a transaction (cancellation, below) can pass `tx`
  // instead of forcing a second, non-transactional round trip.
  async function loadProviderForBooking(
    booking: { providerId: string },
    userId: string,
    userRole: string,
    queryable: Pick<DbClient, "query"> = db,
  ) {
    const provider = await queryable.query.providers.findFirst({ where: eq(providers.id, booking.providerId) });
    return !!provider && (provider.ownerUserId === userId || userRole === "ADMIN");
  }

  // -----------------------------------------------------------------------
  // POST / — create a booking.
  //
  // Core invariant: a booking is created only if the provider, service,
  // pet, requested time, availability rules, and booking conflicts are ALL
  // valid at the authoritative point of reservation. The frontend is never
  // authoritative. A previous availability response is never authoritative.
  // A read taken outside this transaction is never authoritative — only
  // the reads and checks performed here, inside this transaction, are.
  //
  // Concretely: BEGIN -> authoritative reads (provider/service locked with
  // SELECT ... FOR UPDATE, pet, weekly rules, exceptions, active bookings)
  // -> authoritative validation (status/active/availability/conflict) ->
  // derive booking values from the FRESH rows just read -> insert -> rely
  // on database constraints (the EXCLUDE constraint, idempotency-key
  // uniqueness) -> COMMIT. Nothing computed or read before BEGIN is reused
  // for validation or for the values written to the bookings row.
  //
  // The provider and service rows are locked with FOR UPDATE because they
  // carry mutable state (provider.status, service.active) that a
  // concurrent request (e.g. the owner deactivating the provider) could
  // change between an unlocked read and this transaction's COMMIT. Locking
  // them here means a concurrent status-changing UPDATE on that exact row
  // blocks until this transaction finishes, and vice versa — whichever
  // transaction's BEGIN reaches the row first is the one the other
  // serializes behind, so the two can never observe or write inconsistent
  // state. See docs/architecture.md, "Provider/service status race", for
  // the exact guarantee this establishes and why it's the correct choice
  // over locking every request against every provider unconditionally
  // (it isn't — only requests that touch the SAME provider/service row
  // ever contend). The pet row is re-read here too (for a fresh ownership
  // check) but doesn't need FOR UPDATE: pets have no status field to go
  // stale, and the RESTRICT foreign key already prevents a dangling
  // reference from silently producing bad data.
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
    const requestedInstant = new Date(startAt);
    const requestHash = idempotencyKey ? hashBookingRequest(parsed.data) : null;

    try {
      const result = await db.transaction(async (tx) => {
        // --- Authoritative reads -------------------------------------
        const [provider] = await tx.select().from(providers).where(eq(providers.id, providerId)).for("update");
        if (!provider) throw new BookingRouteError(404, PROVIDER_NOT_FOUND);
        if (provider.status !== "ACTIVE") {
          throw new BookingRouteError(409, { error: "This provider is not currently accepting bookings" });
        }

        const [service] = await tx
          .select()
          .from(services)
          .where(and(eq(services.id, serviceId), eq(services.providerId, providerId)))
          .for("update");
        if (!service) throw new BookingRouteError(404, SERVICE_NOT_FOUND);
        if (!service.active) {
          throw new BookingRouteError(409, { error: "This service is no longer available" });
        }

        // Ownership is derived from the session, never a client-supplied
        // customerUserId — createBookingSchema has no such field. A pet
        // that exists but belongs to someone else returns the same 404 as
        // a nonexistent one (the established IDOR-hiding convention).
        const [pet] = await tx.select().from(pets).where(eq(pets.id, petId));
        if (!pet || pet.ownerId !== user.id) {
          throw new BookingRouteError(404, PET_NOT_FOUND);
        }

        // Idempotency is checked BEFORE availability re-validation, not
        // after — a legitimate replay of a request that already succeeded
        // would otherwise be rejected by the availability check below,
        // since the booking IT created is now (correctly) occupying that
        // exact slot. This read alone doesn't claim the key (the
        // insert-with-onConflictDoNothing below does that); it only
        // short-circuits a sequential replay early.
        if (idempotencyKey) {
          const existingClaim = await tx.query.bookingIdempotencyKeys.findFirst({
            where: and(eq(bookingIdempotencyKeys.customerUserId, user.id), eq(bookingIdempotencyKeys.key, idempotencyKey)),
          });
          if (existingClaim && existingClaim.bookingId !== null) {
            if (existingClaim.requestHash !== requestHash) {
              throw new IdempotencyConflictError();
            }
            const existingBooking = await tx.query.bookings.findFirst({ where: eq(bookings.id, existingClaim.bookingId) });
            if (existingBooking) {
              return { booking: existingBooking, replay: true };
            }
          }
        }

        // Re-validate the requested instant against the SAME algorithm
        // the public availability endpoint uses — not a second
        // implementation of "what's a legal slot." This alone enforces
        // slot-interval alignment, full-duration-fits-in-window,
        // exception precedence, and not-in-the-past, all in one reused
        // call — using the provider/service rows just locked above, never
        // anything read before this transaction began.
        const candidateDate = zonedDateString(requestedInstant, provider.timezone);
        const weeklyRules = await tx.query.providerAvailability.findMany({
          where: eq(providerAvailability.providerId, provider.id),
        });
        const exceptionRow = await tx.query.availabilityExceptions.findFirst({
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

        // Slots already consumed by another active booking for this
        // provider (any service — the same provider can't be in two
        // appointments at once) must also be excluded before checking
        // membership.
        const activeBookings = await tx.query.bookings.findMany({
          where: and(eq(bookings.providerId, provider.id), inArray(bookings.status, [...BLOCKING_BOOKING_STATUSES])),
        });
        const availableSlots = excludeBookedSlots(
          candidateSlots,
          service.durationMinutes,
          activeBookings.map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
        );

        const requestedIso = formatZonedIso(requestedInstant, provider.timezone);
        if (!availableSlots.includes(requestedIso)) {
          throw new BookingRouteError(409, { error: "This time slot is not available" });
        }

        // --- Derive booking values from the fresh rows above ----------
        const endAt = new Date(requestedInstant.getTime() + service.durationMinutes * 60_000);

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

        // --- Insert, relying on database constraints -------------------
        const [inserted] = await tx
          .insert(bookings)
          .values({
            customerUserId: user.id,
            providerId: provider.id,
            serviceId: service.id,
            petId: pet.id,
            startAt: requestedInstant,
            endAt,
            // A booking is CONFIRMED only once its payment succeeds (see
            // routes/payments.ts and docs/architecture.md, "Payment
            // state machine") — never at creation. PENDING already
            // occupies the provider's calendar (BLOCKING_BOOKING_STATUSES
            // includes PENDING), so this still fully protects against
            // double-booking while payment is in flight.
            status: "PENDING",
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
      if (err instanceof BookingRouteError) {
        return c.json(err.body, err.status);
      }
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
  //
  // This is the same TOCTOU shape as booking creation: a plain
  // read-then-write outside a transaction would let two concurrent
  // cancel requests (e.g. the customer and the provider owner cancelling
  // at the same moment) both read CONFIRMED, both pass
  // assertBookingStatusTransition, and both unconditionally overwrite the
  // row — the data ends up CANCELLED either way, but the API would
  // (incorrectly) report 200 to both callers instead of one 200 and one
  // 409 "already cancelled". Locking the booking row with
  // SELECT ... FOR UPDATE as the first action inside a transaction
  // closes that: the loser's read is forced to happen only after the
  // winner's UPDATE has committed, so it observes the true CANCELLED
  // status and its own transition check correctly rejects it.
  // -----------------------------------------------------------------------
  app.post("/:id/cancel", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid booking id" }, 400);

    const user = c.get("user");

    try {
      const updated = await db.transaction(async (tx) => {
        const [booking] = await tx.select().from(bookings).where(eq(bookings.id, idResult.data)).for("update");
        if (!booking) throw new BookingRouteError(404, BOOKING_NOT_FOUND);

        const isCustomer = booking.customerUserId === user.id;
        const isProviderOwner = isCustomer ? false : await loadProviderForBooking(booking, user.id, user.role, tx);
        if (!isCustomer && !isProviderOwner) {
          throw new BookingRouteError(404, BOOKING_NOT_FOUND);
        }

        try {
          assertBookingStatusTransition(booking.status, "CANCELLED");
        } catch (err) {
          if (err instanceof BookingStatusTransitionError) {
            throw new BookingRouteError(409, { error: err.message });
          }
          throw err;
        }

        const [row] = await tx
          .update(bookings)
          .set({ status: "CANCELLED", updatedAt: new Date() })
          .where(eq(bookings.id, idResult.data))
          .returning();
        return row;
      });

      return c.json({ booking: toPublicBooking(updated) }, 200);
    } catch (err) {
      if (err instanceof BookingRouteError) {
        return c.json(err.body, err.status);
      }
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // POST /:id/complete — the owning provider (or an admin) marks a
  // CONFIRMED appointment as having actually happened. This is the one
  // and only way a booking ever reaches COMPLETED (see
  // packages/shared/src/bookings.ts's documented lifecycle — CONFIRMED ->
  // COMPLETED has always been a legal transition, nothing produced it
  // until now) — added as the necessary prerequisite for review
  // eligibility (see routes/reviews.ts and docs/architecture.md, "Reviews
  // & ratings"), not a general-purpose booking feature.
  //
  // Deliberately provider/admin-only, never the customer: COMPLETED is an
  // attestation that the service was actually delivered, and only the
  // provider is in a position to know that. Same SELECT ... FOR UPDATE
  // locking as cancel, for the same reason — a plain read-then-write would
  // let a concurrent cancel and complete both read CONFIRMED and both
  // succeed, when at most one legal transition should win.
  // -----------------------------------------------------------------------
  app.post("/:id/complete", async (c) => {
    const idResult = uuidSchema.safeParse(c.req.param("id"));
    if (!idResult.success) return c.json({ error: "Invalid booking id" }, 400);

    const user = c.get("user");

    try {
      const updated = await db.transaction(async (tx) => {
        const [booking] = await tx.select().from(bookings).where(eq(bookings.id, idResult.data)).for("update");
        if (!booking) throw new BookingRouteError(404, BOOKING_NOT_FOUND);

        const isProviderOwner = await loadProviderForBooking(booking, user.id, user.role, tx);
        if (!isProviderOwner) {
          // The booking's own customer already knows this booking exists
          // (it's theirs) — telling them plainly that only the provider
          // can complete it leaks nothing new. Anyone else gets the same
          // 404 a nonexistent booking would, per this codebase's usual
          // IDOR-hiding convention.
          if (booking.customerUserId === user.id) {
            throw new BookingRouteError(403, { error: "Only the provider can mark a booking complete" });
          }
          throw new BookingRouteError(404, BOOKING_NOT_FOUND);
        }

        try {
          assertBookingStatusTransition(booking.status, "COMPLETED");
        } catch (err) {
          if (err instanceof BookingStatusTransitionError) {
            throw new BookingRouteError(409, { error: err.message });
          }
          throw err;
        }

        const [row] = await tx
          .update(bookings)
          .set({ status: "COMPLETED", updatedAt: new Date() })
          .where(eq(bookings.id, idResult.data))
          .returning();
        return row;
      });

      return c.json({ booking: toPublicBooking(updated) }, 200);
    } catch (err) {
      if (err instanceof BookingRouteError) {
        return c.json(err.body, err.status);
      }
      throw err;
    }
  });

  return app;
}
