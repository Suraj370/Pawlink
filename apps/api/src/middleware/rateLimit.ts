import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";
import { clientIp } from "../lib/clientIp.js";

// The minimal surface this middleware actually needs from a Redis
// client — a real `ioredis` instance satisfies this structurally with
// no adapter, and a test can substitute a trivial in-memory fake instead
// of standing up a real Redis server (see rateLimit.test.ts).
export interface RateLimitStore {
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

export type RateLimitRule = {
  name: string;
  method: string;
  match: (path: string) => boolean;
  windowMs: number;
  max: number;
};

// Fixed-window counters, not a true sliding window — a client can burst
// up to ~2x `max` across a window boundary. Documented, deliberate
// trade-off: a sliding-window-log or token-bucket implementation is
// meaningfully more complex for a single-process/single-Redis-instance
// portfolio deployment, and a fixed window is more than sufficient to
// stop the abuse patterns these rules actually target (credential
// stuffing against login, registration spam, booking/payment hammering,
// scraping) — see docs/architecture.md, "Rate limiting."
//
// Endpoint selection follows the milestone brief's own priority list:
// login, registration, booking creation, payment initiation, webhooks,
// admin search, public search/list endpoints. Every other endpoint is
// intentionally left unlimited by this table — rate limiting every
// route uniformly would either be too loose to matter for the
// sensitive ones or too strict for ordinary authenticated CRUD.
export const RATE_LIMIT_RULES: RateLimitRule[] = [
  { name: "auth-login", method: "POST", match: (p) => p === "/api/auth/login", windowMs: 60_000, max: 10 },
  { name: "auth-register", method: "POST", match: (p) => p === "/api/auth/register", windowMs: 60_000, max: 5 },
  { name: "booking-create", method: "POST", match: (p) => p === "/api/bookings", windowMs: 60_000, max: 20 },
  {
    name: "payment-create",
    method: "POST",
    match: (p) => /^\/api\/bookings\/[^/]+\/payment$/.test(p),
    windowMs: 60_000,
    max: 20,
  },
  // Webhooks are server-to-server (the mock payment provider, standing
  // in for a real one) and legitimately deliver more traffic than a
  // single browser ever would, including deliberate retries — a
  // generous ceiling here guards against a malformed/malicious flood
  // without punishing normal at-least-once delivery.
  { name: "payment-webhook", method: "POST", match: (p) => p === "/api/payments/webhook", windowMs: 60_000, max: 120 },
  { name: "admin-search", method: "GET", match: (p) => p.startsWith("/api/admin/"), windowMs: 60_000, max: 60 },
  {
    name: "public-search",
    method: "GET",
    match: (p) => p === "/api/providers" || /^\/api\/providers\/[^/]+\/(services|reviews)$/.test(p),
    windowMs: 60_000,
    max: 120,
  },
];

// keyed by IP (see lib/clientIp.ts) rather than session/user id: the
// endpoints this protects (login, registration especially) are exactly
// the ones an unauthenticated attacker targets, so a per-user key would
// be trivially bypassed by registering a new account per attempt.
//
// trustProxy is threaded straight through to clientIp() from env.ts's
// TRUST_PROXY (default false) — see clientIp.ts for exactly why this
// can't safely default to true.
export function createRateLimit(store: RateLimitStore | null, trustProxy: boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // No Redis configured (development/test — see env.ts) — rate
    // limiting is disabled, not an error.
    if (!store) {
      await next();
      return;
    }

    const rule = RATE_LIMIT_RULES.find((r) => r.method === c.req.method && r.match(c.req.path));
    if (!rule) {
      await next();
      return;
    }

    const key = `ratelimit:${rule.name}:${clientIp(c, trustProxy)}`;
    let count: number;
    let ttlMs: number;
    try {
      count = await store.incr(key);
      if (count === 1) {
        await store.pexpire(key, rule.windowMs);
        ttlMs = rule.windowMs;
      } else {
        ttlMs = await store.pttl(key);
      }
    } catch (err) {
      // Fail OPEN: a Redis outage or network blip must never take down
      // real customer traffic just because rate limiting couldn't run.
      // The request proceeds unlimited for this one attempt; logged so
      // an operator can see the store is unhealthy.
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          msg: "rate limit store error — failing open",
          rule: rule.name,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await next();
      return;
    }

    if (count > rule.max) {
      c.header("Retry-After", String(Math.max(1, Math.ceil(ttlMs / 1000))));
      return c.json({ error: "Too many requests" }, 429);
    }

    await next();
  };
}
