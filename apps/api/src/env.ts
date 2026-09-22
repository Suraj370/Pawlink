import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  WEB_ORIGIN: z.string().url("WEB_ORIGIN must be a valid URL").default("http://localhost:5173"),
  // Signs/verifies the MOCK payment provider's webhook payloads only —
  // this is not a real payment-processor credential and never will be;
  // see lib/payment-provider.ts. Defaulted so local dev/test never needs
  // to set it, but overridable per-environment like any other secret.
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(1).default("dev-mock-payment-webhook-secret"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}
