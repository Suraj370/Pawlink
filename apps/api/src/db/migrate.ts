import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadEnv } from "../env.js";
import { createDb } from "./client.js";

async function main() {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied successfully");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
