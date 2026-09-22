import { test, expect } from "@playwright/test";

test("PawGrid home page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "PawGrid" })).toBeVisible();
  await expect(page.getByText("under development")).toBeVisible();
});
