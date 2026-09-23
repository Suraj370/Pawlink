import { z } from "zod";

// Deliberately lightweight — "is the process alive," nothing that
// touches the database or any other dependency (see docs/architecture.md,
// "Health checks" — that's what GET /ready is for). version is a safe,
// non-secret build identifier (see lib/version.ts), never anything
// derived from configuration or secrets.
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  timestamp: z.string(),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

// GET /ready additionally verifies the one required external dependency
// (Postgres) is actually reachable — status is "ok" only when it is;
// "degraded" when the process is alive but the database check failed.
// Never exposes the database connection string, credentials, or any
// other configuration — just whether the dependency answered.
export const readyResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  timestamp: z.string(),
  version: z.string(),
  checks: z.object({
    database: z.enum(["ok", "unreachable"]),
  }),
});

export type ReadyResponse = z.infer<typeof readyResponseSchema>;

export * from "./auth.js";
export * from "./pets.js";
export * from "./providers.js";
export * from "./services.js";
export * from "./availability.js";
export * from "./bookings.js";
export * from "./payments.js";
export * from "./medical-records.js";
export * from "./audit.js";
export * from "./reviews.js";
export * from "./admin.js";
