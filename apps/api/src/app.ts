import { Hono } from "hono";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { healthResponseSchema } from "@pawgrid/shared";

export function createApp() {
  const app = new Hono();

  app.use("*", logger());

  app.get("/health", (c) => {
    const body = healthResponseSchema.parse({
      status: "ok",
      service: "pawgrid-api",
      timestamp: new Date().toISOString(),
    });
    return c.json(body);
  });

  app.notFound((c) => {
    return c.json({ error: "Not Found" }, 404);
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    console.error("Unhandled error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return app;
}
