import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const app = createApp();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`PawLink API listening on http://localhost:${info.port}`);
});
