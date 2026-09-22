import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { healthResponseSchema } from "@pawlink/shared";
import type { AppEnv } from "./types.js";
import type { DbClient } from "./db/client.js";
import type { Env } from "./env.js";
import { createAuthRoutes } from "./routes/auth.js";

export function createApp(db: DbClient, env: Env) {
  const app = new Hono<AppEnv>();

  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
    }),
  );

  app.get("/health", (c) => {
    const body = healthResponseSchema.parse({
      status: "ok",
      service: "pawlink-api",
      timestamp: new Date().toISOString(),
    });
    return c.json(body);
  });

  app.route("/api/auth", createAuthRoutes(db, env.NODE_ENV));

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
