import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import { createDb, type DbClient } from "./db/client.js";
import { users } from "./db/schema.js";
import { loadEnv } from "./env.js";
import type { AppEnv } from "./types.js";

export function createTestApp() {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  return { app: createApp(db, env), db, env };
}

export function uniqueEmail(prefix = "test"): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

function extractCookieValue(setCookieHeader: string): string {
  const [pair] = setCookieHeader.split(";");
  return pair;
}

// Registers a fresh user and returns the session cookie header value
// (ready to pass as `{ cookie }` on subsequent requests) plus the email,
// so tests never have to duplicate the register-then-extract-cookie dance.
export async function registerAndLogin(app: Hono<AppEnv>) {
  const email = uniqueEmail();
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test User",
      email,
      phone: "5551234567",
      password: "correct-horse-battery",
    }),
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("registerAndLogin: no session cookie returned");
  const cookie = extractCookieValue(setCookie);
  const { user } = (await res.json()) as { user: { id: string } };
  return { cookie, email, userId: user.id };
}

// There is no API path to become an admin (by design — see auth's
// registerSchema). Tests that need an admin actor promote a user directly
// through the database, which is test scaffolding only, never something
// reachable through the API itself.
export async function promoteToAdmin(db: DbClient, userId: string): Promise<void> {
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, userId));
}
