import { Hono, type Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { availabilityQuerySchema, BLOCKING_BOOKING_STATUSES, exceptionInputSchema, weeklyRuleInputSchema } from "@pawlink/shared";
import type { AppEnv } from "../types.js";
import type { DbClient } from "../db/client.js";
import { availabilityExceptions, bookings, providerAvailability, providers, services } from "../db/schema.js";
import { calculateAvailableSlots, SLOT_INTERVAL_MINUTES } from "../lib/availability.js";
import { toPublicException, toPublicWeeklyRule } from "../lib/availability-dto.js";
import { excludeBookedSlots } from "../lib/booking.js";
import { createRequireAuth } from "../middleware/auth.js";

const uuidSchema = z.string().uuid();

const PROVIDER_NOT_FOUND = { error: "Provider not found" } as const;
const SERVICE_NOT_FOUND = { error: "Service not found" } as const;
const RULE_NOT_FOUND = { error: "Availability rule not found" } as const;
const EXCEPTION_NOT_FOUND = { error: "Availability exception not found" } as const;

const UNIQUE_VIOLATION = "23505";
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === UNIQUE_VIOLATION;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

// Half-open interval overlap: back-to-back windows (10:00-13:00 and
// 13:00-18:00) are NOT considered overlapping.
function windowsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return timeToMinutes(aStart) < timeToMinutes(bEnd) && timeToMinutes(bStart) < timeToMinutes(aEnd);
}

export function createAvailabilityRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);

  async function loadProvider(c: Context<AppEnv>) {
    const idResult = uuidSchema.safeParse(c.req.param("providerId"));
    if (!idResult.success) {
      return { error: c.json({ error: "Invalid provider id" }, 400) } as const;
    }
    const provider = await db.query.providers.findFirst({ where: eq(providers.id, idResult.data) });
    if (!provider) {
      return { error: c.json(PROVIDER_NOT_FOUND, 404) } as const;
    }
    return { provider } as const;
  }

  function requireOwnerOrAdmin(c: Context<AppEnv>, provider: { ownerUserId: string }) {
    const user = c.get("user");
    if (provider.ownerUserId !== user.id && user.role !== "ADMIN") {
      return c.json(PROVIDER_NOT_FOUND, 404);
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Public: the actual availability calculation.
  // ---------------------------------------------------------------------
  app.get("/", async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const { provider } = loaded;

    const parsedQuery = availabilityQuerySchema.safeParse({
      date: c.req.query("date"),
      serviceId: c.req.query("serviceId"),
    });
    if (!parsedQuery.success) {
      return c.json({ error: "Invalid query", fields: parsedQuery.error.flatten().fieldErrors }, 400);
    }
    const { date, serviceId } = parsedQuery.data;

    // Availability is only ever exposed for an ACTIVE provider — this
    // applies uniformly (not just to "public" callers), since the whole
    // point of this endpoint is "what could a customer book right now",
    // which has no meaningful answer for a provider that isn't ACTIVE.
    if (provider.status !== "ACTIVE") {
      return c.json(PROVIDER_NOT_FOUND, 404);
    }

    const service = await db.query.services.findFirst({
      where: and(eq(services.id, serviceId), eq(services.providerId, provider.id)),
    });
    if (!service) {
      return c.json(SERVICE_NOT_FOUND, 404);
    }
    if (!service.active) {
      return c.json(SERVICE_NOT_FOUND, 404);
    }

    const weeklyRules = await db.query.providerAvailability.findMany({
      where: eq(providerAvailability.providerId, provider.id),
    });
    const exceptionRow = await db.query.availabilityExceptions.findFirst({
      where: and(eq(availabilityExceptions.providerId, provider.id), eq(availabilityExceptions.date, date)),
    });

    const candidateSlots = calculateAvailableSlots({
      date,
      timezone: provider.timezone,
      serviceDurationMinutes: service.durationMinutes,
      weeklyRules: weeklyRules.map((r) => ({
        dayOfWeek: r.dayOfWeek,
        startTime: r.startTime,
        endTime: r.endTime,
      })),
      exception: exceptionRow
        ? { type: exceptionRow.type, startTime: exceptionRow.startTime, endTime: exceptionRow.endTime }
        : null,
      now: new Date(),
    });

    // calculateAvailableSlots is entirely unaware of bookings (it stays a
    // pure schedule calculation); this is the one place its candidate
    // output is reconciled against what's actually already reserved —
    // "availability tells us what could be booked" ends here, before the
    // response goes out.
    const activeBookings = await db.query.bookings.findMany({
      where: and(eq(bookings.providerId, provider.id), inArray(bookings.status, [...BLOCKING_BOOKING_STATUSES])),
    });
    const slots = excludeBookedSlots(
      candidateSlots,
      service.durationMinutes,
      activeBookings.map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
    );

    return c.json(
      {
        date,
        timezone: provider.timezone,
        slotIntervalMinutes: SLOT_INTERVAL_MINUTES,
        serviceDurationMinutes: service.durationMinutes,
        slots,
      },
      200,
    );
  });

  // ---------------------------------------------------------------------
  // Weekly rules management (owner/admin only).
  // ---------------------------------------------------------------------
  app.get("/rules", requireAuth, async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const authError = requireOwnerOrAdmin(c, loaded.provider);
    if (authError) return authError;

    const rows = await db.query.providerAvailability.findMany({
      where: eq(providerAvailability.providerId, loaded.provider.id),
      orderBy: (r, { asc }) => [asc(r.dayOfWeek), asc(r.startTime)],
    });
    return c.json({ rules: rows.map(toPublicWeeklyRule) }, 200);
  });

  app.post("/rules", requireAuth, async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const authError = requireOwnerOrAdmin(c, loaded.provider);
    if (authError) return authError;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = weeklyRuleInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    // Overlapping windows on the same provider+day are rejected outright
    // rather than allowed — this keeps the schedule deterministic (a
    // given instant is covered by at most one window).
    const sameDayRules = await db.query.providerAvailability.findMany({
      where: and(
        eq(providerAvailability.providerId, loaded.provider.id),
        eq(providerAvailability.dayOfWeek, parsed.data.dayOfWeek),
      ),
    });
    const overlaps = sameDayRules.some((r) =>
      windowsOverlap(parsed.data.startTime, parsed.data.endTime, r.startTime, r.endTime),
    );
    if (overlaps) {
      return c.json({ error: "This window overlaps an existing window for that day" }, 409);
    }

    const [inserted] = await db
      .insert(providerAvailability)
      .values({ ...parsed.data, providerId: loaded.provider.id })
      .returning();

    return c.json({ rule: toPublicWeeklyRule(inserted) }, 201);
  });

  app.patch("/rules/:ruleId", requireAuth, async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const authError = requireOwnerOrAdmin(c, loaded.provider);
    if (authError) return authError;

    const ruleIdResult = uuidSchema.safeParse(c.req.param("ruleId"));
    if (!ruleIdResult.success) {
      return c.json({ error: "Invalid rule id" }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    // A rule is replaced as a whole (day + start + end together), not
    // partially patched — overlap validation needs a coherent full shape,
    // and a weekly window rarely has a meaningful "just change one field"
    // update anyway.
    const parsed = weeklyRuleInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    const existing = await db.query.providerAvailability.findFirst({
      where: and(eq(providerAvailability.id, ruleIdResult.data), eq(providerAvailability.providerId, loaded.provider.id)),
    });
    if (!existing) {
      return c.json(RULE_NOT_FOUND, 404);
    }

    const sameDayRules = await db.query.providerAvailability.findMany({
      where: and(
        eq(providerAvailability.providerId, loaded.provider.id),
        eq(providerAvailability.dayOfWeek, parsed.data.dayOfWeek),
      ),
    });
    const overlaps = sameDayRules
      .filter((r) => r.id !== existing.id)
      .some((r) => windowsOverlap(parsed.data.startTime, parsed.data.endTime, r.startTime, r.endTime));
    if (overlaps) {
      return c.json({ error: "This window overlaps an existing window for that day" }, 409);
    }

    const [updated] = await db
      .update(providerAvailability)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(providerAvailability.id, ruleIdResult.data))
      .returning();

    return c.json({ rule: toPublicWeeklyRule(updated) }, 200);
  });

  app.delete("/rules/:ruleId", requireAuth, async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const authError = requireOwnerOrAdmin(c, loaded.provider);
    if (authError) return authError;

    const ruleIdResult = uuidSchema.safeParse(c.req.param("ruleId"));
    if (!ruleIdResult.success) {
      return c.json({ error: "Invalid rule id" }, 400);
    }

    const existing = await db.query.providerAvailability.findFirst({
      where: and(eq(providerAvailability.id, ruleIdResult.data), eq(providerAvailability.providerId, loaded.provider.id)),
    });
    if (!existing) {
      return c.json(RULE_NOT_FOUND, 404);
    }

    await db.delete(providerAvailability).where(eq(providerAvailability.id, ruleIdResult.data));
    return c.json({ success: true }, 200);
  });

  // ---------------------------------------------------------------------
  // Date exceptions management (owner/admin only).
  // ---------------------------------------------------------------------
  app.get("/exceptions", requireAuth, async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const authError = requireOwnerOrAdmin(c, loaded.provider);
    if (authError) return authError;

    const rows = await db.query.availabilityExceptions.findMany({
      where: eq(availabilityExceptions.providerId, loaded.provider.id),
      orderBy: (e, { asc }) => [asc(e.date)],
    });
    return c.json({ exceptions: rows.map(toPublicException) }, 200);
  });

  app.post("/exceptions", requireAuth, async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const authError = requireOwnerOrAdmin(c, loaded.provider);
    if (authError) return authError;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = exceptionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    let inserted;
    try {
      [inserted] = await db
        .insert(availabilityExceptions)
        .values({
          providerId: loaded.provider.id,
          date: parsed.data.date,
          type: parsed.data.type,
          startTime: parsed.data.startTime ?? null,
          endTime: parsed.data.endTime ?? null,
          reason: parsed.data.reason ?? null,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "An exception already exists for this date" }, 409);
      }
      throw err;
    }

    return c.json({ exception: toPublicException(inserted) }, 201);
  });

  app.patch("/exceptions/:exceptionId", requireAuth, async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const authError = requireOwnerOrAdmin(c, loaded.provider);
    if (authError) return authError;

    const exceptionIdResult = uuidSchema.safeParse(c.req.param("exceptionId"));
    if (!exceptionIdResult.success) {
      return c.json({ error: "Invalid exception id" }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = exceptionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    const existing = await db.query.availabilityExceptions.findFirst({
      where: and(
        eq(availabilityExceptions.id, exceptionIdResult.data),
        eq(availabilityExceptions.providerId, loaded.provider.id),
      ),
    });
    if (!existing) {
      return c.json(EXCEPTION_NOT_FOUND, 404);
    }

    let updated;
    try {
      [updated] = await db
        .update(availabilityExceptions)
        .set({
          date: parsed.data.date,
          type: parsed.data.type,
          startTime: parsed.data.startTime ?? null,
          endTime: parsed.data.endTime ?? null,
          reason: parsed.data.reason ?? null,
          updatedAt: new Date(),
        })
        .where(eq(availabilityExceptions.id, exceptionIdResult.data))
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "An exception already exists for this date" }, 409);
      }
      throw err;
    }

    return c.json({ exception: toPublicException(updated) }, 200);
  });

  app.delete("/exceptions/:exceptionId", requireAuth, async (c) => {
    const loaded = await loadProvider(c);
    if ("error" in loaded) return loaded.error;
    const authError = requireOwnerOrAdmin(c, loaded.provider);
    if (authError) return authError;

    const exceptionIdResult = uuidSchema.safeParse(c.req.param("exceptionId"));
    if (!exceptionIdResult.success) {
      return c.json({ error: "Invalid exception id" }, 400);
    }

    const existing = await db.query.availabilityExceptions.findFirst({
      where: and(
        eq(availabilityExceptions.id, exceptionIdResult.data),
        eq(availabilityExceptions.providerId, loaded.provider.id),
      ),
    });
    if (!existing) {
      return c.json(EXCEPTION_NOT_FOUND, 404);
    }

    await db.delete(availabilityExceptions).where(eq(availabilityExceptions.id, exceptionIdResult.data));
    return c.json({ success: true }, 200);
  });

  return app;
}
