import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

function futureMonday(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 2);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test("customer books an available slot end to end, and it disappears from availability", async ({ browser }) => {
  // Full provider+service+availability+pet+booking setup across two
  // contexts — legitimately heavier than most specs; explicit headroom
  // under full-suite parallel load.
  test.slow();
  const ownerContext = await browser.newContext();
  const customerContext = await browser.newContext();

  try {
    // Provider owner sets up a bookable provider.
    const ownerPage = await ownerContext.newPage();
    const owner = uniqueTestUser("booking-owner");
    await registerViaUI(ownerPage, owner);

    const businessName = `Booking Test Clinic ${Date.now()}`;
    await ownerPage.goto("/providers");
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();
    const providerForm = ownerPage.locator("form");
    await providerForm.getByLabel("Business name").fill(businessName);
    await providerForm.getByLabel("Provider type").selectOption("VET");
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();
    await ownerPage.getByTestId("provider-name").filter({ hasText: businessName }).click();
    await expect(ownerPage).toHaveURL(/\/providers\/[^/]+$/);
    const providerUrl = ownerPage.url();

    await ownerPage.getByRole("button", { name: "Add Service", exact: true }).click();
    const serviceForm = ownerPage.locator("form").last();
    await serviceForm.getByLabel("Name").fill("Consultation");
    await serviceForm.getByLabel("Duration (minutes)").fill("60");
    await serviceForm.getByLabel("Price").fill("799");
    await ownerPage.getByRole("button", { name: "Add Service", exact: true }).click();

    await ownerPage.getByTestId("weekly-rules-manager").getByRole("button", { name: "Add window" }).click();
    const ruleForm = ownerPage.getByTestId("weekly-rules-manager").locator("form");
    await ruleForm.getByLabel("Day").selectOption("MONDAY");
    await ruleForm.getByLabel("Start").fill("09:00");
    await ruleForm.getByLabel("End").fill("11:00");
    await ruleForm.getByRole("button", { name: "Save" }).click();
    await expect(ownerPage.getByTestId("rules-list")).toContainText("MONDAY");

    // Customer registers, adds a pet, and books.
    const customerPage = await customerContext.newPage();
    const customer = uniqueTestUser("booking-customer");
    await registerViaUI(customerPage, customer);

    await customerPage.goto("/pets");
    await customerPage.getByRole("button", { name: "Add Pet", exact: true }).click();
    const petForm = customerPage.locator("form");
    await petForm.getByLabel("Name").fill("Rex");
    await petForm.getByLabel("Species").fill("Dog");
    await customerPage.getByRole("button", { name: "Add Pet", exact: true }).click();
    await expect(customerPage.getByTestId("pets-list")).toContainText("Rex");

    await customerPage.goto(providerUrl);
    const monday = futureMonday();
    const picker = customerPage.getByTestId("slot-picker");
    await picker.getByLabel("Service").selectOption({ label: "Consultation (60 min)" });
    await picker.getByLabel("Date").fill(monday);
    await expect(customerPage.getByTestId("slots-list")).toBeVisible();
    await customerPage.getByTestId("slot-button").filter({ hasText: "09:00" }).click();

    const confirmPanel = customerPage.getByTestId("booking-confirm-panel");
    await expect(confirmPanel).toBeVisible();
    await expect(confirmPanel.getByTestId("booking-review-time")).toContainText("09:00");
    await confirmPanel.getByLabel("Pet").selectOption({ label: "Rex" });
    await confirmPanel.getByRole("button", { name: "Confirm Booking" }).click();

    // The booking is created PENDING, not CONFIRMED — it only becomes
    // CONFIRMED once payment succeeds, which the customer explicitly
    // triggers on the payment step (the mock provider's deterministic
    // "success" scenario).
    const paymentPanel = customerPage.getByTestId("payment-panel");
    await expect(paymentPanel).toBeVisible();
    await paymentPanel.getByTestId("pay-success-button").click();
    await expect(paymentPanel.getByTestId("payment-status-succeeded")).toBeVisible();

    await expect(customerPage.getByTestId("booking-confirmation")).toBeVisible();

    // Booking appears in "My Bookings".
    await customerPage.getByRole("link", { name: "View my bookings" }).click();
    await expect(customerPage).toHaveURL(/\/bookings$/);
    await expect(customerPage.getByTestId("bookings-list")).toContainText("Consultation");
    await expect(customerPage.getByTestId("bookings-list")).toContainText("CONFIRMED");

    // The booked slot is no longer offered.
    await customerPage.goto(providerUrl);
    const picker2 = customerPage.getByTestId("slot-picker");
    await picker2.getByLabel("Service").selectOption({ label: "Consultation (60 min)" });
    await picker2.getByLabel("Date").fill(monday);
    await expect(customerPage.getByTestId("slots-list")).toBeVisible();
    await expect(customerPage.getByTestId("slot-button").filter({ hasText: "09:00" })).toHaveCount(0);
    // A 60-min booking at 09:00 also blocks 09:30 (it would run until
    // 10:30, overlapping the 09:00-10:00 booking) — only 10:00, which
    // starts exactly when the booking ends, remains valid in the
    // 09:00-11:00 window.
    await expect(customerPage.getByTestId("slot-button").filter({ hasText: "09:30" })).toHaveCount(0);
    await expect(customerPage.getByTestId("slot-button").filter({ hasText: "10:00" })).toBeVisible();
  } finally {
    await ownerContext.close();
    await customerContext.close();
  }
});

test("customer cancels a booking, freeing the slot again", async ({ page }) => {
  test.slow();
  const owner = uniqueTestUser("booking-cancel-owner");
  // Owner and customer are the same session here for simplicity (the
  // owner-vs-customer authorization split is covered separately by the
  // cross-user security spec) — this test is purely about the
  // cancel-frees-the-slot lifecycle.
  await registerViaUI(page, owner);

  const businessName = `Cancel Test Clinic ${Date.now()}`;
  await page.goto("/providers");
  await page.getByRole("button", { name: "Add Provider", exact: true }).click();
  const providerForm = page.locator("form");
  await providerForm.getByLabel("Business name").fill(businessName);
  await page.getByRole("button", { name: "Add Provider", exact: true }).click();
  await page.getByTestId("provider-name").filter({ hasText: businessName }).click();
  await expect(page).toHaveURL(/\/providers\/[^/]+$/);
  const providerUrl = page.url();

  await page.getByRole("button", { name: "Add Service", exact: true }).click();
  const serviceForm = page.locator("form").last();
  await serviceForm.getByLabel("Name").fill("Grooming");
  await serviceForm.getByLabel("Duration (minutes)").fill("30");
  await serviceForm.getByLabel("Price").fill("400");
  await page.getByRole("button", { name: "Add Service", exact: true }).click();

  await page.getByTestId("weekly-rules-manager").getByRole("button", { name: "Add window" }).click();
  const ruleForm = page.getByTestId("weekly-rules-manager").locator("form");
  await ruleForm.getByLabel("Day").selectOption("MONDAY");
  await ruleForm.getByLabel("Start").fill("09:00");
  await ruleForm.getByLabel("End").fill("10:00");
  await ruleForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("rules-list")).toContainText("MONDAY");

  await page.goto("/pets");
  await page.getByRole("button", { name: "Add Pet", exact: true }).click();
  const petForm = page.locator("form");
  await petForm.getByLabel("Name").fill("Fido");
  await petForm.getByLabel("Species").fill("Dog");
  await page.getByRole("button", { name: "Add Pet", exact: true }).click();
  // Wait for the creation to actually land before navigating away — an
  // immediate goto() can otherwise abort the in-flight POST /api/pets
  // request, silently leaving no pet for the booking step below to find.
  await expect(page.getByTestId("pets-list")).toContainText("Fido");

  const monday = futureMonday();
  await page.goto(providerUrl);
  const picker = page.getByTestId("slot-picker");
  await picker.getByLabel("Service").selectOption({ label: "Grooming (30 min)" });
  await picker.getByLabel("Date").fill(monday);
  await page.getByTestId("slot-button").filter({ hasText: "09:00" }).click();
  const confirmPanel = page.getByTestId("booking-confirm-panel");
  await confirmPanel.getByLabel("Pet").selectOption({ label: "Fido" });
  await confirmPanel.getByRole("button", { name: "Confirm Booking" }).click();

  const paymentPanel = page.getByTestId("payment-panel");
  await expect(paymentPanel).toBeVisible();
  await paymentPanel.getByTestId("pay-success-button").click();
  await expect(paymentPanel.getByTestId("payment-status-succeeded")).toBeVisible();

  await expect(page.getByTestId("booking-confirmation")).toBeVisible();

  await page.getByRole("link", { name: "View my bookings" }).click();
  await page.getByTestId("booking-row").filter({ hasText: "Grooming" }).click();
  await expect(page).toHaveURL(/\/bookings\/[^/]+$/);
  await expect(page.getByTestId("booking-status")).toHaveText("CONFIRMED");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await expect(page.getByTestId("booking-status")).toHaveText("CANCELLED");

  // The slot is bookable again.
  await page.goto(providerUrl);
  const picker2 = page.getByTestId("slot-picker");
  await picker2.getByLabel("Service").selectOption({ label: "Grooming (30 min)" });
  await picker2.getByLabel("Date").fill(monday);
  await expect(page.getByTestId("slot-button").filter({ hasText: "09:00" })).toBeVisible();
});
