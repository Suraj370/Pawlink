import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";

export function createTestApp() {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  return { app: createApp(db, env), db, env };
}

export function uniqueEmail(prefix = "test"): string {
  return `${prefix}-${randomUUID()}@example.com`;
}
