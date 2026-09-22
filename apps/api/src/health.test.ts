import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("GET /health", () => {
  it("returns a 200 with an ok status payload", async () => {
    const app = createApp();
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
