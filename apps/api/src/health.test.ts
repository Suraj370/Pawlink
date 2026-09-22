import { describe, expect, it } from "vitest";
import { createTestApp } from "./test-helpers.js";

describe("GET /health", () => {
  it("returns a 200 with an ok status payload", async () => {
    const { app } = createTestApp();
    const res = await app.request("/health");

    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; service: string; timestamp: string };
    expect(body).toMatchObject({
      status: "ok",
      service: "pawlink-api",
    });
    expect(typeof body.timestamp).toBe("string");
  });
});
