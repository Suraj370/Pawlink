import { test, expect } from "@playwright/test";

test("PawLink home page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "PawLink" })).toBeVisible();
  await expect(page.getByText("under development")).toBeVisible();
});
