import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";

function uniqueTestUser() {
  const id = randomUUID();
  return {
    name: "E2E Test User",
    email: `e2e-${id}@example.com`,
    phone: "5551234567",
    password: "correct-horse-battery-staple",
  };
}

test("register, session survives refresh, logout denies access, re-login works", async ({ page }) => {
  const user = uniqueTestUser();

  // 1. Register a new pet-parent account.
  await page.goto("/register");
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Phone").fill(user.phone);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();

  // 2. Registration succeeds and the authenticated dashboard appears.
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("welcome-message")).toHaveText(`Welcome, ${user.name}`);

  // 3. Refresh the page: the server-backed session must survive.
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("welcome-message")).toHaveText(`Welcome, ${user.name}`);

  // 4. Log out.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // 5. Direct navigation to the protected route is now denied.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);

  // 6. Log back in with the same credentials.
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("welcome-message")).toHaveText(`Welcome, ${user.name}`);
});
