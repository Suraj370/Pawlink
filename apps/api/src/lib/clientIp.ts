import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { AppEnv } from "../types.js";

// The IP address a rate-limit bucket is keyed by.
//
// X-Forwarded-For is ONLY trusted when trustProxy is true (see env.ts's
// TRUST_PROXY — defaults to false). This matters: X-Forwarded-For is
// client-supplied input. It's only safe to trust when a reverse proxy
// that's the sole public entry point sits in front of this process and
// itself sets/overwrites the header before forwarding — a config this
// repo does NOT currently ship. docker-compose.prod.yml publishes the
// API container's own port directly to the host (see that file's own
// comment on this) with no reverse proxy in front of it at all, so
// trusting X-Forwarded-For there would let any anonymous client rotate
// a spoofed value per request and bypass every rate limit in this
// codebase entirely. (An earlier version of this comment incorrectly
// claimed such a proxy existed — it doesn't; this was caught and fixed
// during this milestone's own adversarial review.)
//
// With trustProxy false (the default, and correct for the topology this
// repo actually ships), this always uses the raw socket address instead
// — which, for a topology where this process's port IS the public entry
// point, is genuinely the real client address, not a proxy's.
export function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwardedFor = c.req.header("X-Forwarded-For");
    if (forwardedFor) {
      const first = forwardedFor.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  try {
    // getConnInfo reads the real Node.js socket, which only exists when
    // this app is actually served over HTTP (via @hono/node-server's
    // serve()) — Hono's in-process app.request() test harness (used
    // throughout this codebase's test suite) has no such socket and
    // throws here. Falling back to "unknown" rather than propagating
    // that: an unresolvable IP degrades this one caller's rate-limit
    // bucket to a single shared "unknown" bucket, which is a strictly
    // safer failure mode than a 500 on every request.
    const info = getConnInfo(c);
    return info.remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
