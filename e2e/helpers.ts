import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

export function uniqueTestUser(prefix = "e2e") {
  const id = randomUUID();
  return {
    name: `${prefix} Test User`,
    email: `${prefix}-${id}@example.com`,
    phone: "5551234567",
    password: "correct-horse-battery-staple",
  };
}

export async function registerViaUI(page: Page, user: ReturnType<typeof uniqueTestUser>) {
  await page.goto("/register");
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Phone").fill(user.phone);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/dashboard$/);
}
