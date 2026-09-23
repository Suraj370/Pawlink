import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://pawlink:pawlink@localhost:5432/pawlink";

// The Playwright-side equivalent of apps/api/src/test-helpers.ts's
// promoteToAdmin. There is no API path to become an admin — by design,
// see docs/architecture.md, "Admin & operations — role provisioning" —
// so E2E specs that need an admin session connect directly to the same
// Postgres instance the dev API server uses, exactly like the backend's
// own test helper does through Drizzle, just via plain `pg` here since
// e2e specs run outside the API workspace.
export async function promoteToAdminByEmail(email: string): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query("UPDATE users SET role = 'ADMIN' WHERE email = $1", [email]);
  } finally {
    await client.end();
  }
}
