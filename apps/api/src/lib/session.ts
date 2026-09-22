import { createHash, randomBytes } from "node:crypto";
import type { CookieOptions } from "hono/utils/cookie";

export const SESSION_COOKIE_NAME = "pawlink_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

// Only the hash is ever persisted; the raw token lives solely in the
// browser's cookie, so reading the sessions table can't yield a usable
// credential.
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionCookieOptions(nodeEnv: string): CookieOptions {
  return {
    httpOnly: true,
    secure: nodeEnv === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
