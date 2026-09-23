import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { healthResponseSchema, readyResponseSchema } from "@pawlink/shared";
import type { AppEnv } from "./types.js";
import type { DbClient } from "./db/client.js";
import type { Env } from "./env.js";
import { createRequestId } from "./middleware/requestId.js";
import { createRequestLogging } from "./middleware/requestLogging.js";
import { createSecurityHeaders } from "./middleware/securityHeaders.js";
import { createRateLimit } from "./middleware/rateLimit.js";
import { createRedisClient } from "./lib/redis.js";
import { resolveAppVersion } from "./lib/version.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createPetRoutes } from "./routes/pets.js";
import { createProviderRoutes } from "./routes/providers.js";
import { createServiceRoutes } from "./routes/services.js";
import { createAvailabilityRoutes } from "./routes/availability.js";
import { createBookingRoutes } from "./routes/bookings.js";
import { createBookingPaymentRoutes, createMockPaymentProvider, createPaymentRoutes } from "./routes/payments.js";
import { createMedicalRecordRoutes, createPetMedicalRecordRoutes } from "./routes/medical-records.js";
import { createBookingReviewRoutes, createProviderReviewRoutes, createReviewRoutes } from "./routes/reviews.js";
import { createAdminDashboardRoutes } from "./routes/admin/dashboard.js";
import { createAdminProviderRoutes } from "./routes/admin/providers.js";
import { createAdminUserRoutes } from "./routes/admin/users.js";
import { createAdminBookingRoutes } from "./routes/admin/bookings.js";
import { createAdminPaymentRoutes } from "./routes/admin/payments.js";
import { createAdminReviewRoutes } from "./routes/admin/reviews.js";
import { createAdminAuditRoutes } from "./routes/admin/audit.js";

export function createApp(db: DbClient, env: Env) {
  const app = new Hono<AppEnv>();
  // The one concrete PaymentProvider implementation today. Swapping in a
  // real provider later (Stripe/Razorpay/etc.) means constructing a
  // different implementation of the SAME PaymentProvider interface here
  // — routes/payments.ts never changes. See lib/payment-provider.ts.
  const paymentProvider = createMockPaymentProvider(env.MOCK_PAYMENT_WEBHOOK_SECRET);
  // null in development/test (no REDIS_URL configured) — rate limiting
  // then runs as a safe no-op. See env.ts and middleware/rateLimit.ts.
  const redis = createRedisClient(env.REDIS_URL);
  const appVersion = resolveAppVersion(env.APP_VERSION);

  // Request id first (every later middleware/log line can reference it),
  // then structured request logging (see docs/architecture.md,
  // "Structured logging" — this REPLACES Hono's own dev-oriented
  // logger() rather than running alongside it), then security headers,
  // then CORS, then rate limiting — in that order, so a rate-limited
  // (429) response still carries a request id, a log line, and the same
  // security headers every other response gets.
  app.use("*", createRequestId());
  app.use("*", createRequestLogging());
  app.use("*", createSecurityHeaders(env.NODE_ENV));
  app.use(
    "*",
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
    }),
  );
  app.use("*", createRateLimit(redis, env.TRUST_PROXY));

  // Deliberately lightweight — never touches the database or any other
  // dependency (see the milestone brief's "do not make health endpoints
  // perform expensive queries"). This only answers "is the process
  // alive." See GET /ready, below, for the dependency check.
  app.get("/health", (c) => {
    const body = healthResponseSchema.parse({
      status: "ok",
      service: "pawlink-api",
      timestamp: new Date().toISOString(),
      version: appVersion,
    });
    return c.json(body);
  });

  // A trivial SELECT 1 — enough to prove the configured DATABASE_URL is
  // actually reachable, deliberately nothing more expensive than that
  // (never a real table scan, never anything that could show up as load
  // on a dashboard someone's actually trying to read). Never exposes the
  // connection string, credentials, or any other configuration — only
  // whether the dependency answered.
  app.get("/ready", async (c) => {
    let databaseOk = true;
    try {
      await db.execute(sql`select 1`);
    } catch {
      databaseOk = false;
    }
    const body = readyResponseSchema.parse({
      status: databaseOk ? "ok" : "degraded",
      service: "pawlink-api",
      timestamp: new Date().toISOString(),
      version: appVersion,
      checks: { database: databaseOk ? "ok" : "unreachable" },
    });
    return c.json(body, databaseOk ? 200 : 503);
  });

  app.route("/api/auth", createAuthRoutes(db, env.NODE_ENV));
  app.route("/api/pets", createPetRoutes(db, env.NODE_ENV));
  app.route("/api/providers", createProviderRoutes(db, env.NODE_ENV));
  app.route("/api/providers/:providerId/services", createServiceRoutes(db, env.NODE_ENV));
  app.route("/api/providers/:providerId/availability", createAvailabilityRoutes(db, env.NODE_ENV));
  app.route("/api/bookings", createBookingRoutes(db, env.NODE_ENV));
  app.route("/api/bookings/:bookingId/payment", createBookingPaymentRoutes(db, env.NODE_ENV, paymentProvider));
  app.route("/api/payments", createPaymentRoutes(db, env.NODE_ENV, paymentProvider));
  app.route("/api/pets/:petId/medical-records", createPetMedicalRecordRoutes(db, env.NODE_ENV));
  app.route("/api/medical-records", createMedicalRecordRoutes(db, env.NODE_ENV));
  app.route("/api/bookings/:bookingId/review", createBookingReviewRoutes(db, env.NODE_ENV));
  app.route("/api/reviews", createReviewRoutes(db, env.NODE_ENV));
  app.route("/api/providers/:providerId/reviews", createProviderReviewRoutes(db));
  app.route("/api/admin/dashboard", createAdminDashboardRoutes(db, env.NODE_ENV));
  app.route("/api/admin/providers", createAdminProviderRoutes(db, env.NODE_ENV));
  app.route("/api/admin/users", createAdminUserRoutes(db, env.NODE_ENV));
  app.route("/api/admin/bookings", createAdminBookingRoutes(db, env.NODE_ENV));
  app.route("/api/admin/payments", createAdminPaymentRoutes(db, env.NODE_ENV));
  app.route("/api/admin/reviews", createAdminReviewRoutes(db, env.NODE_ENV));
  app.route("/api/admin/audit", createAdminAuditRoutes(db, env.NODE_ENV));

  app.notFound((c) => {
    return c.json({ error: "Not Found" }, 404);
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    // The server-side log line carries the full error (message + stack,
    // via Node's own console.error formatting) and the request id that
    // ties it back to the structured access-log line
    // (createRequestLogging) for that same request — but the RESPONSE
    // sent to the client never does: no stack trace, no SQL, no
    // filesystem path, no internal exception message. This is the one
    // place in the whole API that still has to guard against an
    // UNEXPECTED error leaking internals — every route that already
    // knows how to fail cleanly (a Zod validation error, a known
    // domain conflict) returns its own clean JSON error well before
    // ever reaching this handler.
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        msg: "unhandled error",
        request_id: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
      }),
    );
    console.error(err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return app;
}
