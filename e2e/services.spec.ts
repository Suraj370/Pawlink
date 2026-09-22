import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

test("provider owner can create, edit, and deactivate a service", async ({ page }) => {
  const owner = uniqueTestUser("service-owner");
  await registerViaUI(page, owner);

  const businessName = `Service Test Groomer ${Date.now()}`;
  await page.goto("/providers");
  await page.getByRole("button", { name: "Add Provider", exact: true }).click();
  const providerForm = page.locator("form");
  await providerForm.getByLabel("Business name").fill(businessName);
  await providerForm.getByLabel("Provider type").selectOption("GROOMER");
  await page.getByRole("button", { name: "Add Provider", exact: true }).click();
  await page.getByTestId("provider-name").filter({ hasText: businessName }).click();
  await expect(page).toHaveURL(/\/providers\/[^/]+$/);

  // Create service.
  await expect(page.getByTestId("services-empty-state")).toBeVisible();
  await page.getByRole("button", { name: "Add Service", exact: true }).click();
  const serviceForm = page.locator("form").last();
  await serviceForm.getByLabel("Name").fill("Basic Grooming");
  await serviceForm.getByLabel("Description").fill("A quick wash and trim");
  await serviceForm.getByLabel("Duration (minutes)").fill("60");
  await serviceForm.getByLabel("Price").fill("799");
  await page.getByRole("button", { name: "Add Service", exact: true }).click();

  // Verify service appears.
  const serviceRow = page.getByTestId("service-row").filter({ hasText: "Basic Grooming" });
  await expect(serviceRow).toBeVisible();
  await expect(serviceRow.getByTestId("service-details")).toContainText("60 minutes");
  await expect(serviceRow.getByTestId("service-details")).toContainText("799.00");

  // Edit service.
  await serviceRow.getByRole("button", { name: "Edit" }).click();
  const editForm = page.locator("form").last();
  await editForm.getByLabel("Name").fill("Basic Grooming Updated");
  await editForm.getByLabel("Price").fill("899");
  await page.getByRole("button", { name: "Save changes" }).click();

  const updatedRow = page.getByTestId("service-row").filter({ hasText: "Basic Grooming Updated" });
  await expect(updatedRow).toBeVisible();
  await expect(updatedRow.getByTestId("service-details")).toContainText("899.00");

  // Deactivate.
  await updatedRow.getByRole("button", { name: "Deactivate" }).click();
  await expect(updatedRow.getByTestId("service-inactive-badge")).toBeVisible();

  // Verify it disappears from public listing (fresh, logged-out view).
  const providerUrl = page.url();
  await page.context().clearCookies();
  await page.goto(providerUrl);
  await expect(page.getByTestId("services-empty-state")).toBeVisible();
  await expect(page.getByTestId("service-row")).toHaveCount(0);
});

test("public customer sees only active services for a provider", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const visitorContext = await browser.newContext();

  try {
    const ownerPage = await ownerContext.newPage();
    const owner = uniqueTestUser("service-visibility-owner");
    await registerViaUI(ownerPage, owner);

    const businessName = `Visibility Test Vet ${Date.now()}`;
    await ownerPage.goto("/providers");
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();
    const providerForm = ownerPage.locator("form");
    await providerForm.getByLabel("Business name").fill(businessName);
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();
    await ownerPage.getByTestId("provider-name").filter({ hasText: businessName }).click();
    await expect(ownerPage).toHaveURL(/\/providers\/[^/]+$/);
    const providerUrl = ownerPage.url();

    // Active service.
    await ownerPage.getByRole("button", { name: "Add Service", exact: true }).click();
    let form = ownerPage.locator("form").last();
    await form.getByLabel("Name").fill("Active Consultation");
    await form.getByLabel("Duration (minutes)").fill("30");
    await form.getByLabel("Price").fill("500");
    await ownerPage.getByRole("button", { name: "Add Service", exact: true }).click();

    // Inactive service.
    await ownerPage.getByRole("button", { name: "Add Service", exact: true }).click();
    form = ownerPage.locator("form").last();
    await form.getByLabel("Name").fill("Inactive Consultation");
    await form.getByLabel("Duration (minutes)").fill("30");
    await form.getByLabel("Price").fill("500");
    await ownerPage.getByRole("button", { name: "Add Service", exact: true }).click();
    const inactiveRow = ownerPage.getByTestId("service-row").filter({ hasText: "Inactive Consultation" });
    await inactiveRow.getByRole("button", { name: "Deactivate" }).click();
    await expect(inactiveRow.getByTestId("service-inactive-badge")).toBeVisible();

    // A fresh, unauthenticated visitor.
    const visitorPage = await visitorContext.newPage();
    await visitorPage.goto(providerUrl);
    await expect(visitorPage.getByTestId("service-row").filter({ hasText: "Active Consultation" })).toBeVisible();
    await expect(visitorPage.getByTestId("service-row").filter({ hasText: "Inactive Consultation" })).toHaveCount(0);
    // No owner controls at all for a public visitor.
    await expect(visitorPage.getByRole("button", { name: "Add Service" })).not.toBeVisible();
  } finally {
    await ownerContext.close();
    await visitorContext.close();
  }
});
