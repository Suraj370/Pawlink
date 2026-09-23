import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import type { PublicUser } from "@pawlink/shared";
import type { AppEnv } from "../types.js";
import type { DbClient } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { SESSION_COOKIE_NAME, hashSessionToken, sessionCookieOptions } from "../lib/session.js";
import { toPublicUser } from "../lib/user.js";

export async function resolveUser(db: DbClient, token: string | undefined): Promise<PublicUser | null> {
  if (!token) return null;

  const hashedToken = hashSessionToken(token);

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, hashedToken),
  });
  if (!session) return null;

  if (session.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, hashedToken));
    return null;
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
  });
  if (!user) return null;

  return toPublicUser(user);
}

export function createRequireAuth(db: DbClient, nodeEnv: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    const user = await resolveUser(db, token);

    if (!user) {
      deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieOptions(nodeEnv));
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("user", user);
    await next();
  };
}

// The one reusable authorization gate every /api/admin/* route goes
// through — see docs/architecture.md, "Admin & operations." Layers on
// top of createRequireAuth (so an unauthenticated caller still gets 401,
// never a misleading "forbidden"): once authenticated, anything but
// role === "ADMIN" gets a plain 403. Unlike the pets/bookings/medical-
// records/reviews convention of hiding a resource's existence behind a
// 404, there is nothing to hide here — the /api/admin/* namespace's
// existence is not a secret, only who may use it is gated, so a normal
// 403 "Forbidden" is the right, unambiguous response for every
// non-admin caller, authenticated or not.
//
// The admin role itself comes from the authenticated user's own trusted
// session-derived row (resolveUser -> toPublicUser -> users.role),
// never a client-supplied header, body field, query parameter, or
// frontend flag — there is no code path anywhere that lets a request
// claim ADMIN for itself.
export function createRequireAdmin(db: DbClient, nodeEnv: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    const user = await resolveUser(db, token);

    if (!user) {
      deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieOptions(nodeEnv));
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (user.role !== "ADMIN") {
      return c.json({ error: "Forbidden" }, 403);
    }

    c.set("user", user);
    await next();
  };
}
