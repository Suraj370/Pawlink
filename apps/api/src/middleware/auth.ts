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
