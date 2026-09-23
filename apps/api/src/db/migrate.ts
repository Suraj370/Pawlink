import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadEnv } from "../env.js";
import { createDb } from "./client.js";

// Resolved relative to THIS module's own compiled location
// (dist/db/migrate.js -> ../../drizzle, i.e. apps/api/drizzle), never to
// process.cwd(). A plain "./drizzle" only ever worked locally because
// dev always happens to invoke this script with apps/api/ as the
// working directory (`npm run db:migrate --workspace apps/api`, via
// package.json's "db:migrate": "tsx src/db/migrate.ts"). The production
// Docker image's WORKDIR is the repo root, not apps/api (see
// apps/api/Dockerfile) — running this script there with a
// cwd-relative path silently pointed at a nonexistent folder. See
// docs/architecture.md, "Migration safety."
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

async function main() {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  await migrate(db, { migrationsFolder });
  console.log("Migrations applied successfully");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
