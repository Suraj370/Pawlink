import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  timestamp: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from "./auth.js";
export * from "./pets.js";
export * from "./providers.js";
export * from "./services.js";
export * from "./availability.js";
export * from "./bookings.js";
export * from "./payments.js";
