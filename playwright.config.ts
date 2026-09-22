import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Every spec drives a real browser against a single shared dev API +
  // Postgres instance (no mocking), and several specs now run multi-step
  // multi-context workflows (booking creation, cross-user security
  // proofs). Full CPU-count parallelism (Playwright's default) oversubscribes
  // that single backend badly enough on a typical dev machine that the
  // heavier specs can time out purely from contention, not from any
  // actual bug — confirmed by the same spec completing in ~5s in
  // isolation vs. timing out at 90s under full default parallelism. This
  // cap trades some wall-clock time for the suite actually being
  // reliable; raise it if running against a beefier machine or a
  // dedicated CI runner.
  workers: 4,
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
