import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

function futureMonday(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 2);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function setUpBookableProviderAndReachPaymentStep(page: import("@playwright/test").Page, serviceName: string) {
  const owner = uniqueTestUser("payment-owner");
  await registerViaUI(page, owner);

  const businessName = `Payment Test Clinic ${Date.now()}`;
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
  await serviceForm.getByLabel("Name").fill(serviceName);
  await serviceForm.getByLabel("Duration (minutes)").fill("30");
  await serviceForm.getByLabel("Price").fill("500");
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
  await petForm.getByLabel("Name").fill("Milo");
  await petForm.getByLabel("Species").fill("Cat");
  await page.getByRole("button", { name: "Add Pet", exact: true }).click();
  await expect(page.getByTestId("pets-list")).toContainText("Milo");

  const monday = futureMonday();
  await page.goto(providerUrl);
  const picker = page.getByTestId("slot-picker");
  await picker.getByLabel("Service").selectOption({ label: `${serviceName} (30 min)` });
  await picker.getByLabel("Date").fill(monday);
  await page.getByTestId("slot-button").filter({ hasText: "09:00" }).click();
  const confirmPanel = page.getByTestId("booking-confirm-panel");
  await confirmPanel.getByLabel("Pet").selectOption({ label: "Milo" });
  await confirmPanel.getByRole("button", { name: "Confirm Booking" }).click();

  const paymentPanel = page.getByTestId("payment-panel");
  await expect(paymentPanel).toBeVisible();
  return { paymentPanel, providerUrl, monday };
}

test("a failed mock payment leaves the booking unconfirmed, with a clear explanation", async ({ page }) => {
  test.slow();
  const { paymentPanel } = await setUpBookableProviderAndReachPaymentStep(page, "Failing Checkup");

  await paymentPanel.getByTestId("pay-failure-button").click();
  await expect(paymentPanel.getByTestId("payment-status-failed")).toBeVisible({ timeout: 15_000 });
  await expect(paymentPanel.getByTestId("payment-status-failed")).toContainText("not confirmed");

  // No premature "booking confirmed" screen is ever shown, and the
  // failure path never renders a "View my bookings" link the way the
  // success path's booking-confirmation block does — navigate directly.
  await expect(page.getByTestId("booking-confirmation")).toHaveCount(0);

  // The booking itself reflects the true, server-decided outcome: CANCELLED, not CONFIRMED.
  await page.goto("/bookings");
  await expect(page.getByTestId("bookings-list")).toContainText("CANCELLED");
});

test("a pending mock payment shows a processing state, never a premature confirmation", async ({ page }) => {
  test.slow();
  const { paymentPanel } = await setUpBookableProviderAndReachPaymentStep(page, "Pending Checkup");

  await paymentPanel.getByTestId("pay-pending-button").click();
  await expect(paymentPanel.getByTestId("payment-status-pending")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("booking-confirmation")).toHaveCount(0);
});

test("once a booking is paid, its payment step never offers to pay again", async ({ page }) => {
  // Proves duplicate-payment protection is visible in the UI, not just
  // enforced server-side: after a successful payment, revisiting this
  // exact booking's detail page must show it as already paid/confirmed,
  // never a fresh "Pay now" prompt that could create a second payment.
  // (The deeper guarantee — that the SERVER also rejects a genuinely
  // concurrent duplicate attempt — is proven directly against the API in
  // apps/api/src/payments.test.ts, "concurrency" and "duplicate payment
  // protection".)
  test.slow();
  const { paymentPanel } = await setUpBookableProviderAndReachPaymentStep(page, "Duplicate Pay Checkup");

  await paymentPanel.getByTestId("pay-success-button").click();
  await expect(paymentPanel.getByTestId("payment-status-succeeded")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("booking-confirmation")).toBeVisible();

  await page.getByRole("link", { name: "View my bookings" }).click();
  await page.getByTestId("booking-row").filter({ hasText: "Duplicate Pay Checkup" }).click();
  await expect(page).toHaveURL(/\/bookings\/[^/]+$/);
  await expect(page.getByTestId("booking-status")).toHaveText("CONFIRMED");
  // A CONFIRMED booking never renders the payment panel at all (see
  // $bookingId.tsx: it's only shown while status === "PENDING").
  await expect(page.getByTestId("payment-panel")).toHaveCount(0);
});
