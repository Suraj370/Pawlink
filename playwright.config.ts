import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
  },
  // The frontend depends on the API for health/auth, so both must be
  // running for the E2E suite to exercise the real integration rather
  // than just the static page. PostgreSQL (docker compose up -d postgres)
  // and applied migrations are a prerequisite the test runner can't start
  // itself; see docs/getting-started.md.
  webServer: [
    {
      command: "npm run dev --workspace apps/api",
      url: "http://localhost:3000/health",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "npm run dev --workspace apps/web",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
