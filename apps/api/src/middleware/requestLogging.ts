import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { AppEnv } from "../types.js";

// A single structured JSON line per request — this replaces Hono's
// built-in dev-oriented logger() entirely rather than running alongside
// it, so there is exactly one log line per request, not two differently
// -shaped ones. See docs/architecture.md, "Structured logging," for the
// full field list and what's deliberately never logged.
//
// Fields are the exact set the milestone brief calls for: timestamp,
// level, request_id, method, route, status, duration_ms, and — only
// when operationally useful and only ever an id, never content —
// user_id. There is deliberately no request-body logging anywhere in
// this middleware (or anywhere else in this codebase): a booking's
// price, a medical record's title, a review's comment, a session
// cookie, an Authorization header — none of it is ever written to a log
// line. `route` is Hono's own matched-pattern string (e.g.
// "/api/pets/:petId/medical-records"), not the raw URL, so a real id in
// the path never gets logged as part of the route field either — only
// as a plain top-level `path` for operational grep-ability, still never
// the query string (which could carry a search term) or the body.
export function createRequestLogging(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const durationMs = Math.round(performance.now() - start);

    const user = (() => {
      try {
        return c.get("user");
      } catch {
        return undefined;
      }
    })();

    const line = {
      timestamp: new Date().toISOString(),
      level: c.res.status >= 500 ? "error" : c.res.status >= 400 ? "warn" : "info",
      request_id: c.get("requestId"),
      method: c.req.method,
      // Called AFTER next() so this reflects the actual matched route
      // pattern (e.g. "/api/pets/:petId/medical-records"), not "*" —
      // routePath() resolves relative to whatever route index Hono is
      // currently on, which is only meaningful post-routing.
      route: routePath(c),
      path: c.req.path,
      status: c.res.status,
      duration_ms: durationMs,
      ...(user ? { user_id: user.id } : {}),
    };
    console.log(JSON.stringify(line));
  };
}
