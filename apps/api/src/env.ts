import "dotenv/config";
import { z } from "zod";

// The one well-known default this repo ships in apps/api/.env.example —
// safe for local dev/test (it only signs the MOCK payment provider's own
// webhook payloads, never a real credential), but a production
// deployment that's still using it means nobody ever set a real value,
// which the refinement below turns into a hard startup failure rather
// than a silent, insecure default. See "Startup validation," below.
const DEV_MOCK_WEBHOOK_SECRET = "dev-mock-payment-webhook-secret";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    // Required in every environment — there is no safe default for a
    // database connection string, and this schema has never provided
    // one.
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    WEB_ORIGIN: z.string().url("WEB_ORIGIN must be a valid URL").default("http://localhost:5173"),
    // Signs/verifies the MOCK payment provider's webhook payloads only —
    // this is not a real payment-processor credential and never will be;
    // see lib/payment-provider.ts. Defaulted so local dev/test never
    // needs to set it, but production must override it (enforced below).
    MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(1).default(DEV_MOCK_WEBHOOK_SECRET),
    // A safe, non-secret build identifier (a commit SHA, a CI build
    // number) surfaced through GET /health — never anything derived
    // from a secret. Optional: local dev has no build pipeline to set
    // it, so it simply reads "dev" in that case (see lib/version.ts).
    APP_VERSION: z.string().trim().min(1).optional(),
    // Backs Redis-based rate limiting (see lib/redis.ts,
    // middleware/rateLimit.ts). Optional in development/test — the
    // existing fast local dev/test workflow was never built around
    // requiring a Redis container, and every route this codebase's own
    // test suite exercises heavily (registration, login, booking
    // creation, admin authorization matrices that loop over many
    // requests) would need per-test rate-limit resets otherwise. When
    // unset, rate limiting middleware runs as a safe no-op — see
    // "Startup validation," below, for why production can't leave it
    // unset.
    REDIS_URL: z.string().min(1).optional(),
    // Whether to trust an incoming X-Forwarded-For header for rate-limit
    // keying (see lib/clientIp.ts). Defaults to false — trusting it is
    // only safe when this process sits behind a reverse proxy that's the
    // sole public entry point and itself sets/overwrites that header,
    // never behind a config that publishes this API's port directly to
    // untrusted clients (exactly what docker-compose.prod.yml does today
    // — see its own comment). With this false (the default), rate
    // limiting instead keys on the raw socket address, which for that
    // exact "port published directly" topology IS the real client
    // address; flipping this to true without a real proxy in front would
    // let any anonymous client bypass every rate limit in this codebase
    // by sending a different X-Forwarded-For value per request.
    //
    // Deliberately NOT z.coerce.boolean() — that coerces via JS's
    // Boolean(), so the string "false" (still a non-empty string) would
    // coerce to true, exactly backwards from what an operator setting
    // TRUST_PROXY=false would expect.
    TRUST_PROXY: z
      .preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean())
      .default(false),
  })
  // Startup validation for required production configuration (see the
  // milestone brief's "a production server should fail clearly if a
  // required secret/configuration is missing"): a production process
  // that's still carrying the checked-in dev default for a value that's
  // supposed to be a real per-deployment secret is exactly the silent
  // misconfiguration this refinement exists to catch — it fails loudly
  // at startup, before the server ever accepts a request, rather than
  // quietly running with a publicly-known "secret."
  .refine((env) => env.NODE_ENV !== "production" || env.MOCK_PAYMENT_WEBHOOK_SECRET !== DEV_MOCK_WEBHOOK_SECRET, {
    message: "MOCK_PAYMENT_WEBHOOK_SECRET must be set to a real, non-default value in production",
    path: ["MOCK_PAYMENT_WEBHOOK_SECRET"],
  })
  // Rate limiting silently no-ops without Redis (see middleware/
  // rateLimit.ts) — fine for development/test, not acceptable for a
  // production deployment, where login/registration/booking/payment/
  // webhook endpoints going unprotected is exactly the gap section 14 of
  // this hardening milestone exists to close. Production must configure
  // a real REDIS_URL rather than silently running unprotected.
  .refine((env) => env.NODE_ENV !== "production" || !!env.REDIS_URL, {
    message: "REDIS_URL is required in production (rate limiting would otherwise silently be disabled)",
    path: ["REDIS_URL"],
  });

export type Env = z.infer<typeof envSchema>;

// Never logs a secret's VALUE, only which field(s) failed and why (Zod's
// own field-level messages, which this schema deliberately never
// interpolates a real env value into) — see docs/architecture.md,
// "Secret hygiene."
export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}
