import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createTestApp } from "./test-helpers.js";
import { createRateLimit, RATE_LIMIT_RULES, type RateLimitStore } from "./middleware/rateLimit.js";
import type { AppEnv } from "./types.js";

describe("request id", () => {
  it("generates a request id and echoes it in the response header", async () => {
    const { app } = createTestApp();
    const res = await app.request("/health");
    const id = res.headers.get("X-Request-ID");
    expect(id).toBeTruthy();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reflects a well-formed incoming X-Request-ID instead of generating a new one", async () => {
    const { app } = createTestApp();
    const res = await app.request("/health", { headers: { "X-Request-ID": "caller-supplied-id-123" } });
    expect(res.headers.get("X-Request-ID")).toBe("caller-supplied-id-123");
  });

  it("ignores an unsafe/malformed incoming X-Request-ID and generates a fresh one", async () => {
    const { app } = createTestApp();
    const res = await app.request("/health", { headers: { "X-Request-ID": "<script>alert(1)</script>" } });
    const id = res.headers.get("X-Request-ID");
    expect(id).not.toBe("<script>alert(1)</script>");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects an absurdly long incoming X-Request-ID and generates a fresh one instead", async () => {
    const { app } = createTestApp();
    const res = await app.request("/health", { headers: { "X-Request-ID": "a".repeat(10_000) } });
    const id = res.headers.get("X-Request-ID");
    expect(id?.length).toBeLessThan(200);
  });
});

describe("security headers", () => {
  it("sets the expected headers on every response, including an error response", async () => {
    const { app } = createTestApp();
    const res = await app.request("/health");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");

    const notFoundRes = await app.request("/api/does-not-exist");
    expect(notFoundRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("does not set Strict-Transport-Security outside production", async () => {
    const { app } = createTestApp();
    const res = await app.request("/health");
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });
});

describe("error responses never leak internals", () => {
  it("a 500 from an unexpected error never includes a stack trace or exception message", async () => {
    const app = new Hono<AppEnv>();
    app.get("/boom", () => {
      throw new Error("super secret internal detail: /etc/passwd, DATABASE_URL=postgres://real:creds@host/db");
    });
    app.onError((err, c) => {
      console.error(err);
      return c.json({ error: "Internal Server Error" }, 500);
    });

    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/secret internal detail/);
    expect(text).not.toMatch(/DATABASE_URL/);
    expect(text).not.toMatch(/postgres:\/\//);
    expect(text).toBe(JSON.stringify({ error: "Internal Server Error" }));
  });
});

// -----------------------------------------------------------------------
// Rate limiting — unit-tested against a minimal in-memory fake store
// rather than a real Redis server, so this suite stays fast/hermetic
// while still proving the actual limiting logic (not just "some
// middleware exists"). See middleware/rateLimit.ts's own comment on why
// a fixed window, and docs/architecture.md, "Rate limiting," for the
// full design (Redis-backed in real deployments — see lib/redis.ts —
// disabled by default in dev/test).
// -----------------------------------------------------------------------
class FakeStore implements RateLimitStore {
  private counts = new Map<string, number>();
  private expiresAt = new Map<string, number>();

  async incr(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
  async pexpire(key: string, milliseconds: number): Promise<unknown> {
    this.expiresAt.set(key, Date.now() + milliseconds);
    return 1;
  }
  async pttl(key: string): Promise<number> {
    const exp = this.expiresAt.get(key);
    return exp ? Math.max(0, exp - Date.now()) : -1;
  }
}

class ThrowingStore implements RateLimitStore {
  async incr(): Promise<number> {
    throw new Error("connection refused");
  }
  async pexpire(): Promise<unknown> {
    throw new Error("connection refused");
  }
  async pttl(): Promise<number> {
    throw new Error("connection refused");
  }
}

function buildRateLimitedApp(store: RateLimitStore | null, trustProxy = false) {
  const app = new Hono<AppEnv>();
  app.use("*", createRateLimit(store, trustProxy));
  app.post("/api/auth/login", (c) => c.json({ ok: true }));
  app.get("/api/providers", (c) => c.json({ ok: true }));
  app.get("/api/pets", (c) => c.json({ ok: true })); // never rate-limited
  return app;
}

describe("rate limiting", () => {
  it("is disabled (no-op) when no store is configured — matches development/test", async () => {
    const app = buildRateLimitedApp(null);
    for (let i = 0; i < 50; i++) {
      const res = await app.request("/api/auth/login", { method: "POST" });
      expect(res.status).toBe(200);
    }
  });

  it("allows requests up to the configured limit, then rejects with 429 and Retry-After", async () => {
    const loginRule = RATE_LIMIT_RULES.find((r) => r.name === "auth-login")!;
    const app = buildRateLimitedApp(new FakeStore());

    for (let i = 0; i < loginRule.max; i++) {
      const res = await app.request("/api/auth/login", { method: "POST" });
      expect(res.status).toBe(200);
    }

    const limited = await app.request("/api/auth/login", { method: "POST" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    const body = (await limited.json()) as { error: string };
    expect(body.error).toBe("Too many requests");
  });

  it("tracks separate buckets per rule — hitting the login limit doesn't affect an unrelated route", async () => {
    const loginRule = RATE_LIMIT_RULES.find((r) => r.name === "auth-login")!;
    const app = buildRateLimitedApp(new FakeStore());

    for (let i = 0; i <= loginRule.max; i++) {
      await app.request("/api/auth/login", { method: "POST" });
    }

    const petsRes = await app.request("/api/pets");
    expect(petsRes.status).toBe(200);
  });

  it("never limits a route with no matching rule", async () => {
    const app = buildRateLimitedApp(new FakeStore());
    for (let i = 0; i < 500; i++) {
      const res = await app.request("/api/pets");
      expect(res.status).toBe(200);
    }
  });

  it("fails OPEN when the store errors — a Redis outage never blocks real traffic", async () => {
    const app = buildRateLimitedApp(new ThrowingStore());
    const res = await app.request("/api/auth/login", { method: "POST" });
    expect(res.status).toBe(200);
  });

  // Regression coverage for the topology gap an adversarial review of this
  // milestone caught: docker-compose.prod.yml publishes the API's port
  // directly to the host with no reverse proxy in front of it, so trusting
  // a client-supplied X-Forwarded-For by default would let any anonymous
  // caller bypass every rate limit by sending a different value per
  // request. See env.ts's TRUST_PROXY and lib/clientIp.ts.
  describe("TRUST_PROXY", () => {
    it("with trustProxy false (the default), a spoofed X-Forwarded-For does not bypass the limit", async () => {
      const loginRule = RATE_LIMIT_RULES.find((r) => r.name === "auth-login")!;
      const app = buildRateLimitedApp(new FakeStore(), false);

      // Every request claims a different attacker-controlled IP — if this
      // were honored, each would land in its own fresh bucket and never
      // hit the limit. With trustProxy false it must be ignored, so all
      // requests fall into the same (unresolvable-socket-in-tests)
      // bucket and the limit still bites.
      for (let i = 0; i < loginRule.max; i++) {
        const res = await app.request("/api/auth/login", {
          method: "POST",
          headers: { "X-Forwarded-For": `10.0.0.${i}` },
        });
        expect(res.status).toBe(200);
      }

      const limited = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "X-Forwarded-For": "10.0.0.999" },
      });
      expect(limited.status).toBe(429);
    });

    it("with trustProxy true, each distinct X-Forwarded-For gets its own bucket", async () => {
      const loginRule = RATE_LIMIT_RULES.find((r) => r.name === "auth-login")!;
      const app = buildRateLimitedApp(new FakeStore(), true);

      for (let i = 0; i < loginRule.max; i++) {
        const res = await app.request("/api/auth/login", {
          method: "POST",
          headers: { "X-Forwarded-For": "203.0.113.1" },
        });
        expect(res.status).toBe(200);
      }
      const limited = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "X-Forwarded-For": "203.0.113.1" },
      });
      expect(limited.status).toBe(429);

      // A different claimed IP is a fresh bucket, entirely unaffected by
      // the one above having just been exhausted.
      const otherIp = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "X-Forwarded-For": "203.0.113.2" },
      });
      expect(otherIp.status).toBe(200);
    });
  });
});
