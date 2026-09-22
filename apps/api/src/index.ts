import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const app = createApp(db, env);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`PawLink API listening on http://localhost:${info.port}`);
});
