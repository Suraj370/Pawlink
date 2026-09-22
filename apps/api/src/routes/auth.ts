import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { loginSchema, registerSchema } from "@pawlink/shared";
import type { AppEnv } from "../types.js";
import type { DbClient } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  generateSessionToken,
  hashSessionToken,
  sessionCookieOptions,
} from "../lib/session.js";
import { toPublicUser } from "../lib/user.js";
import { createRequireAuth } from "../middleware/auth.js";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === UNIQUE_VIOLATION;
}

export function createAuthRoutes(db: DbClient, nodeEnv: string) {
  const app = new Hono<AppEnv>();
  const requireAuth = createRequireAuth(db, nodeEnv);

  async function createSession(userId: string) {
    const token = generateSessionToken();
    await db.insert(sessions).values({
      id: hashSessionToken(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    });
    return token;
  }

  app.post("/register", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    const { name, email, phone, password } = parsed.data;
    const passwordHash = await hashPassword(password);

    let inserted;
    try {
      // Role is never taken from the request; public registration always
      // gets the default PET_PARENT role, enforced server-side.
      [inserted] = await db
        .insert(users)
        .values({ name, email, phone, passwordHash })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "Email is already registered" }, 409);
      }
      console.error("Registration failed:", err);
      return c.json({ error: "Registration failed" }, 500);
    }

    const token = await createSession(inserted.id);
    setCookie(c, SESSION_COOKIE_NAME, token, sessionCookieOptions(nodeEnv));

    return c.json({ user: toPublicUser(inserted) }, 201);
  });

  app.post("/login", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors }, 400);
    }

    const { email, password } = parsed.data;

    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    // Same generic message whether the account doesn't exist or the
    // password is wrong, so the endpoint doesn't leak which accounts exist.
    const genericError = { error: "Invalid email or password" } as const;
    if (!user) {
      return c.json(genericError, 401);
    }

    const validPassword = await verifyPassword(password, user.passwordHash);
    if (!validPassword) {
      return c.json(genericError, 401);
    }

    const token = await createSession(user.id);
    setCookie(c, SESSION_COOKIE_NAME, token, sessionCookieOptions(nodeEnv));

    return c.json({ user: toPublicUser(user) }, 200);
  });

  app.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (token) {
      await db.delete(sessions).where(eq(sessions.id, hashSessionToken(token)));
    }
    deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieOptions(nodeEnv));
    return c.json({ success: true }, 200);
  });

  app.get("/me", requireAuth, (c) => {
    return c.json({ user: c.get("user") }, 200);
  });

  return app;
}
