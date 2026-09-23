import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";

// A conservative allowlist: letters, digits, hyphens, underscores, 8-128
// chars. This is deliberately not "any string a client sends" — an
// incoming X-Request-ID is untrusted input that ends up in structured
// logs and a response header, so it's validated the same way any other
// externally-supplied value in this codebase is (see the milestone
// brief's "prefer incoming X-Request-ID only if validated safely"). A
// client sending something outside this shape (an injection attempt, a
// header-splitting payload, an absurdly long value) simply gets a
// server-generated id instead, never an error — the correlation id is
// an operational convenience, not something worth rejecting a request
// over.
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function createRequestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header("X-Request-ID");
    const requestId = incoming && SAFE_REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-ID", requestId);
    await next();
  };
}
