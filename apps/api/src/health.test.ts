import { describe, expect, it } from "vitest";
import { createTestApp } from "./test-helpers.js";

describe("GET /health", () => {
  it("returns a 200 with an ok status payload", async () => {
    const { app } = createTestApp();
    const res = await app.request("/health");

    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; service: string; timestamp: string; version: string };
    expect(body).toMatchObject({
      status: "ok",
      service: "pawlink-api",
    });
    expect(typeof body.timestamp).toBe("string");
    // No REDIS_URL/APP_VERSION set in the test environment — falls back
    // to "dev" (see lib/version.ts), never undefined/empty.
    expect(body.version).toBe("dev");
  });

  it("never exposes DATABASE_URL, credentials, or any other configuration", async () => {
    const { app } = createTestApp();
    const res = await app.request("/health");
    const text = await res.text();
    expect(text).not.toMatch(/postgres:\/\//);
    expect(text).not.toMatch(/DATABASE_URL/);
  });

  it("responds quickly (never touches the database)", async () => {
    const { app } = createTestApp();
    const start = Date.now();
    await app.request("/health");
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("GET /ready", () => {
  it("returns 200 with database: ok when Postgres is reachable", async () => {
    const { app } = createTestApp();
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: { database: string } };
    expect(body.status).toBe("ok");
    expect(body.checks.database).toBe("ok");
  });

  it("never exposes DATABASE_URL or credentials", async () => {
    const { app } = createTestApp();
    const res = await app.request("/ready");
    const text = await res.text();
    expect(text).not.toMatch(/postgres:\/\//);
  });
});
