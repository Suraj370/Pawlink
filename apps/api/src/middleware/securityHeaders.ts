import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";

// This API only ever returns JSON — it never serves HTML, so most of a
// typical CSP's directives (script-src, style-src, img-src, ...) don't
// apply to it the way they would to the frontend (see
// apps/web/nginx.conf for that side of this same audit). What's still
// worth setting here, and what this middleware sets:
//
// - X-Content-Type-Options: nosniff — stops a browser from ever trying
//   to MIME-sniff a JSON response as HTML/script, which matters even for
//   a JSON-only API if a response is ever loaded in a context that
//   doesn't respect Content-Type.
// - Referrer-Policy: strict-origin-when-cross-origin — a reasonable,
//   non-breaking default; this API doesn't need referrer data and
//   shouldn't leak full request URLs (which can carry query strings) to
//   third parties.
// - X-Frame-Options: DENY / frame-ancestors 'none' — this API is never
//   meant to be framed.
// - Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
//   — the strictest possible policy, safe here specifically because the
//   API never serves renderable content of any kind.
// - Strict-Transport-Security — only set in production (see the comment
//   below); asserting HTTPS-only over plain HTTP in development would
//   just break local `http://localhost` testing for no benefit.
export function createSecurityHeaders(nodeEnv: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (nodeEnv === "production") {
      // Only meaningful (and only safe to assert) once the deployment
      // is actually served over HTTPS — see apps/api/Dockerfile /
      // docker-compose.prod.yml, where a reverse proxy terminates TLS in
      // front of this process.
      c.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
  };
}
