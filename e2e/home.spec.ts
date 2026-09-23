import { test, expect } from "@playwright/test";

test("PawLink home page loads and proves the frontend-to-backend health flow", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("link", { name: "PawLink" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /trusted care for happier pets/i })).toBeVisible();

  // The status starts as "checking" while TanStack Query's request (sent
  // via Ky) to GET /health is in flight, and only flips to "online" once
  // the real Hono API has responded — this exercises the whole chain
  // (React -> TanStack Query -> Ky -> Hono API), not just static rendering.
  const status = page.getByTestId("api-status");
  await expect(status).toHaveText("API status: online", { timeout: 10_000 });
});
