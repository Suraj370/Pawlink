import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { healthResponseSchema } from "@pawlink/shared";
import type { AppEnv } from "./types.js";
import type { DbClient } from "./db/client.js";
import type { Env } from "./env.js";
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

  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
    }),
  );

  app.get("/health", (c) => {
    const body = healthResponseSchema.parse({
      status: "ok",
      service: "pawlink-api",
      timestamp: new Date().toISOString(),
    });
    return c.json(body);
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
    console.error("Unhandled error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return app;
}
