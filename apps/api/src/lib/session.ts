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
  const secure = nodeEnv === "production";
  return {
    httpOnly: true,
    secure,
    // Production serves the frontend and API from different registrable
    // domains (e.g. a Vercel domain and a Render/Fly domain), which
    // makes every API call a cross-site request. SameSite=Lax cookies
    // are only sent on top-level navigations, never on cross-site
    // fetch/XHR — so with Lax here, the session cookie would never be
    // sent back on GET /api/auth/me or any other API call, making every
    // page refresh (and even the very next request after login) look
    // unauthenticated. SameSite=None fixes that, and is only safe
    // combined with Secure (browsers drop a None cookie outright
    // without it) — which is exactly when this applies, since `secure`
    // is only true in production. Dev/test stays on the stricter Lax:
    // localhost:5173 and localhost:3000 differ only by port, which is
    // still the same "site" for SameSite purposes, so Lax already works
    // there without weakening anything.
    sameSite: secure ? "None" : "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
