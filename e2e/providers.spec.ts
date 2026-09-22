import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

test("public visitor can discover, filter, and view a provider without logging in", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const visitorContext = await browser.newContext();

  try {
    const ownerPage = await ownerContext.newPage();
    const owner = uniqueTestUser("discover-owner");
    await registerViaUI(ownerPage, owner);

    const businessName = `Discoverable Vet ${Date.now()}`;
    const city = `Discoverytown${Date.now()}`;

    await ownerPage.goto("/providers");
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();
    const createForm = ownerPage.locator("form");
    await createForm.getByLabel("Business name").fill(businessName);
    await createForm.getByLabel("Provider type").selectOption("VET");
    await createForm.getByLabel("Description").fill("A discoverable test clinic");
    await createForm.getByLabel("City").fill(city);
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();
    await expect(ownerPage.getByTestId("providers-list")).toContainText(businessName);

    // A fresh, unauthenticated context: public discovery must not require login.
    const visitorPage = await visitorContext.newPage();
    await visitorPage.goto("/providers");
    await expect(visitorPage.getByRole("link", { name: "Log in to list your business" })).toBeVisible();

    await visitorPage.getByLabel("Type").selectOption("VET");
    await visitorPage.getByLabel("City").fill(city);
    await expect(visitorPage.getByTestId("providers-list")).toContainText(businessName);

    await visitorPage.getByTestId("provider-name").filter({ hasText: businessName }).click();
    await expect(visitorPage).toHaveURL(/\/providers\/[^/]+$/);
    await expect(visitorPage.getByTestId("provider-detail-name")).toHaveText(businessName);
    await expect(visitorPage.getByText("A discoverable test clinic")).toBeVisible();

    // A non-owner (here, an anonymous visitor) must never see owner controls.
    await expect(visitorPage.getByRole("button", { name: "Edit" })).not.toBeVisible();
    await expect(visitorPage.getByRole("button", { name: "Deactivate" })).not.toBeVisible();
  } finally {
    await ownerContext.close();
    await visitorContext.close();
  }
});

test("provider owner can create, edit, and deactivate their provider", async ({ page }) => {
  const owner = uniqueTestUser("provider-owner");
  await registerViaUI(page, owner);

  const businessName = `Owner Workflow Groomer ${Date.now()}`;
  const city = `Groomington${Date.now()}`;

  await page.goto("/providers");
  await page.getByRole("button", { name: "Add Provider", exact: true }).click();
  const createForm = page.locator("form");
  await createForm.getByLabel("Business name").fill(businessName);
  await createForm.getByLabel("Provider type").selectOption("GROOMER");
  await createForm.getByLabel("City").fill(city);
  await page.getByRole("button", { name: "Add Provider", exact: true }).click();

  await expect(page.getByTestId("providers-list")).toContainText(businessName);
  await page.getByTestId("provider-name").filter({ hasText: businessName }).click();
  await expect(page).toHaveURL(/\/providers\/[^/]+$/);
  const providerUrl = page.url();

  // Owner sees status and management controls; verified against the
  // publicly-hidden-otherwise "Status" row.
  await expect(page.getByTestId("provider-status")).toHaveText("ACTIVE");

  await page.getByRole("button", { name: "Edit" }).click();
  const updatedName = `${businessName} Updated`;
  await page.getByLabel("Business name").fill(updatedName);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("provider-detail-name")).toHaveText(updatedName);

  // Deactivate (soft delete).
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByTestId("provider-status")).toHaveText("INACTIVE");

  // The owner can still see it directly by id (soft delete keeps the row)…
  await page.goto(providerUrl);
  await expect(page.getByTestId("provider-detail-name")).toHaveText(updatedName);

  // …but it's gone from public discovery.
  await page.context().clearCookies();
  await page.goto("/providers");
  await page.getByLabel("City").fill(city);
  await expect(page.getByTestId("providers-empty-state")).toBeVisible();
});
