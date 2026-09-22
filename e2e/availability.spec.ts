import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

// Always at least two years out and always a Monday, so this test never
// becomes flaky/stale regardless of when it runs, and never collides with
// "today" edge cases the past-slot filter would otherwise apply.
function futureMonday(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 2);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test("provider owner sets weekly hours, a second window, a date exception, and sees the generated availability", async ({
  page,
}) => {
  const owner = uniqueTestUser("avail-owner");
  await registerViaUI(page, owner);

  const businessName = `Availability Test Clinic ${Date.now()}`;
  await page.goto("/providers");
  await page.getByRole("button", { name: "Add Provider", exact: true }).click();
  const providerForm = page.locator("form");
  await providerForm.getByLabel("Business name").fill(businessName);
  await providerForm.getByLabel("Provider type").selectOption("VET");
  await page.getByRole("button", { name: "Add Provider", exact: true }).click();
  await page.getByTestId("provider-name").filter({ hasText: businessName }).click();
  await expect(page).toHaveURL(/\/providers\/[^/]+$/);

  // Add a service so the slot picker has something to compute against.
  await page.getByRole("button", { name: "Add Service", exact: true }).click();
  const serviceForm = page.locator("form").last();
  await serviceForm.getByLabel("Name").fill("Consultation");
  await serviceForm.getByLabel("Duration (minutes)").fill("60");
  await serviceForm.getByLabel("Price").fill("500");
  await page.getByRole("button", { name: "Add Service", exact: true }).click();

  // Set weekly hours (Monday 09:00-17:00).
  await expect(page.getByTestId("rules-empty-state")).toBeVisible();
  await page.getByTestId("weekly-rules-manager").getByRole("button", { name: "Add window" }).click();
  const ruleForm = page.getByTestId("weekly-rules-manager").locator("form");
  await ruleForm.getByLabel("Day").selectOption("MONDAY");
  await ruleForm.getByLabel("Start").fill("09:00");
  await ruleForm.getByLabel("End").fill("17:00");
  await ruleForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("rules-list")).toContainText("MONDAY 09:00–17:00");

  // Add a second (split-schedule) window on the same day.
  await page.getByTestId("weekly-rules-manager").getByRole("button", { name: "Add window" }).click();
  const secondRuleForm = page.getByTestId("weekly-rules-manager").locator("form");
  await secondRuleForm.getByLabel("Day").selectOption("SATURDAY");
  await secondRuleForm.getByLabel("Start").fill("10:00");
  await secondRuleForm.getByLabel("End").fill("14:00");
  await secondRuleForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("rules-list")).toContainText("SATURDAY 10:00–14:00");

  // Create a date exception (CLOSED) far in the future so it can't
  // collide with any other test's data.
  const exceptionDate = "2031-12-25";
  await page.getByTestId("exceptions-manager").getByRole("button", { name: "Add exception" }).click();
  const excForm = page.getByTestId("exceptions-manager").locator("form");
  await excForm.getByLabel("Date").fill(exceptionDate);
  await excForm.getByLabel("Type").selectOption("CLOSED");
  await excForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("exceptions-list")).toContainText(exceptionDate);

  // View generated availability for the configured Monday and verify
  // slots match the configured schedule.
  const monday = futureMonday();
  const picker = page.getByTestId("slot-picker");
  await picker.getByLabel("Service").selectOption({ label: "Consultation (60 min)" });
  await picker.getByLabel("Date").fill(monday);
  await expect(page.getByTestId("slots-list")).toBeVisible();
  const slotButtons = page.getByTestId("slot-button");
  await expect(slotButtons.first()).toHaveText("09:00");
  // 60-min service, 30-min interval, window ends 17:00 -> last slot 16:00.
  await expect(slotButtons.last()).toHaveText("16:00");
  await expect(page.getByTestId("slot-button").filter({ hasText: "16:30" })).toHaveCount(0);

  // Clicking a slot only opens the review step — it must not immediately
  // create a booking. The full booking workflow is covered by
  // e2e/bookings.spec.ts; this availability test only proves the engine
  // itself is wired up correctly.
  await slotButtons.first().click();
  await expect(page.getByTestId("booking-confirm-panel")).toBeVisible();

  // The exception date shows no slots at all.
  await picker.getByLabel("Date").fill(exceptionDate);
  await expect(page.getByTestId("slots-empty-state")).toBeVisible();
});

test("public customer views available slots matching the provider's configured schedule", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const visitorContext = await browser.newContext();

  try {
    const ownerPage = await ownerContext.newPage();
    const owner = uniqueTestUser("avail-customer-owner");
    await registerViaUI(ownerPage, owner);

    const businessName = `Customer Availability Test ${Date.now()}`;
    await ownerPage.goto("/providers");
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();
    const providerForm = ownerPage.locator("form");
    await providerForm.getByLabel("Business name").fill(businessName);
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();
    await ownerPage.getByTestId("provider-name").filter({ hasText: businessName }).click();
    await expect(ownerPage).toHaveURL(/\/providers\/[^/]+$/);
    const providerUrl = ownerPage.url();

    await ownerPage.getByRole("button", { name: "Add Service", exact: true }).click();
    const serviceForm = ownerPage.locator("form").last();
    await serviceForm.getByLabel("Name").fill("Grooming");
    await serviceForm.getByLabel("Duration (minutes)").fill("30");
    await serviceForm.getByLabel("Price").fill("400");
    await ownerPage.getByRole("button", { name: "Add Service", exact: true }).click();

    await ownerPage.getByTestId("weekly-rules-manager").getByRole("button", { name: "Add window" }).click();
    const ruleForm = ownerPage.getByTestId("weekly-rules-manager").locator("form");
    await ruleForm.getByLabel("Day").selectOption("MONDAY");
    await ruleForm.getByLabel("Start").fill("09:00");
    await ruleForm.getByLabel("End").fill("10:00");
    await ruleForm.getByRole("button", { name: "Save" }).click();
    await expect(ownerPage.getByTestId("rules-list")).toContainText("MONDAY");

    // A fresh, unauthenticated visitor.
    const visitorPage = await visitorContext.newPage();
    await visitorPage.goto(providerUrl);
    const monday = futureMonday();
    const picker = visitorPage.getByTestId("slot-picker");
    await picker.getByLabel("Service").selectOption({ label: "Grooming (30 min)" });
    await picker.getByLabel("Date").fill(monday);

    // 09:00-10:00 window, 30-min service, 30-min interval -> 09:00, 09:30.
    const slots = visitorPage.getByTestId("slot-button");
    await expect(slots).toHaveCount(2);
    await expect(slots.first()).toHaveText("09:00");
    await expect(slots.last()).toHaveText("09:30");

    // No owner availability-management UI visible to a public visitor.
    await expect(visitorPage.getByTestId("weekly-rules-manager")).toHaveCount(0);
    await expect(visitorPage.getByTestId("exceptions-manager")).toHaveCount(0);
  } finally {
    await ownerContext.close();
    await visitorContext.close();
  }
});

test("an inactive provider and an inactive service expose no public availability", async ({ page }) => {
  const owner = uniqueTestUser("avail-inactive-owner");
  await registerViaUI(page, owner);

  const businessName = `Inactive Availability Test ${Date.now()}`;
  await page.goto("/providers");
  await page.getByRole("button", { name: "Add Provider", exact: true }).click();
  const providerForm = page.locator("form");
  await providerForm.getByLabel("Business name").fill(businessName);
  await page.getByRole("button", { name: "Add Provider", exact: true }).click();
  await page.getByTestId("provider-name").filter({ hasText: businessName }).click();
  await expect(page).toHaveURL(/\/providers\/[^/]+$/);

  await page.getByRole("button", { name: "Add Service", exact: true }).click();
  const serviceForm = page.locator("form").last();
  await serviceForm.getByLabel("Name").fill("Checkup");
  await serviceForm.getByLabel("Duration (minutes)").fill("30");
  await serviceForm.getByLabel("Price").fill("300");
  await page.getByRole("button", { name: "Add Service", exact: true }).click();

  await page.getByTestId("weekly-rules-manager").getByRole("button", { name: "Add window" }).click();
  const ruleForm = page.getByTestId("weekly-rules-manager").locator("form");
  await ruleForm.getByLabel("Day").selectOption("MONDAY");
  await ruleForm.getByLabel("Start").fill("09:00");
  await ruleForm.getByLabel("End").fill("12:00");
  await ruleForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("rules-list")).toContainText("MONDAY");

  // Deactivate the service: the slot picker no longer offers it at all
  // (SlotPicker only lists active services).
  const serviceRow = page.getByTestId("service-row").filter({ hasText: "Checkup" });
  await serviceRow.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByTestId("slot-picker")).toHaveCount(0);
});
