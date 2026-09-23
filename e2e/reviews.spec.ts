import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

function futureMonday(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 2);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Full setup shared by both workflow tests: a provider owner with a
// bookable service, a customer who owns a pet, a CONFIRMED booking, and
// the provider marking it COMPLETED (the one and only way a booking
// becomes eligible for a review — see docs/architecture.md, "Reviews &
// ratings").
async function setupCompletedBooking(
  ownerPage: import("@playwright/test").Page,
  customerPage: import("@playwright/test").Page,
  label: string,
) {
  const owner = uniqueTestUser(`${label}-owner`);
  await registerViaUI(ownerPage, owner);

  const businessName = `${label} Clinic ${Date.now()}`;
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
  await serviceForm.getByLabel("Name").fill("Checkup");
  await serviceForm.getByLabel("Duration (minutes)").fill("60");
  await serviceForm.getByLabel("Price").fill("500");
  await ownerPage.getByRole("button", { name: "Add Service", exact: true }).click();

  await ownerPage.getByTestId("weekly-rules-manager").getByRole("button", { name: "Add window" }).click();
  const ruleForm = ownerPage.getByTestId("weekly-rules-manager").locator("form");
  await ruleForm.getByLabel("Day").selectOption("MONDAY");
  await ruleForm.getByLabel("Start").fill("09:00");
  await ruleForm.getByLabel("End").fill("11:00");
  await ruleForm.getByRole("button", { name: "Save" }).click();
  await expect(ownerPage.getByTestId("rules-list")).toContainText("MONDAY");

  const customer = uniqueTestUser(`${label}-customer`);
  await registerViaUI(customerPage, customer);

  await customerPage.goto("/pets");
  await customerPage.getByRole("button", { name: "Add Pet", exact: true }).click();
  const petForm = customerPage.locator("form");
  await petForm.getByLabel("Name").fill("Rex");
  await petForm.getByLabel("Species").fill("Dog");
  await customerPage.getByRole("button", { name: "Add Pet", exact: true }).click();
  await expect(customerPage.getByTestId("pets-list")).toContainText("Rex");

  const monday = futureMonday();
  await customerPage.goto(providerUrl);
  const picker = customerPage.getByTestId("slot-picker");
  await picker.getByLabel("Service").selectOption({ label: "Checkup (60 min)" });
  await picker.getByLabel("Date").fill(monday);
  await expect(customerPage.getByTestId("slots-list")).toBeVisible();
  await customerPage.getByTestId("slot-button").filter({ hasText: "09:00" }).click();

  const confirmPanel = customerPage.getByTestId("booking-confirm-panel");
  await confirmPanel.getByLabel("Pet").selectOption({ label: "Rex" });
  await confirmPanel.getByRole("button", { name: "Confirm Booking" }).click();

  const paymentPanel = customerPage.getByTestId("payment-panel");
  await expect(paymentPanel).toBeVisible();
  await paymentPanel.getByTestId("pay-success-button").click();
  // Not asserting the intermediate "payment-status-succeeded" state here:
  // it can be genuinely transient (the booking query's own invalidation
  // can unmount PaymentPanel before that state ever gets painted) — the
  // terminal booking-confirmation screen is what this setup actually
  // needs and is never reached on a failed/pending payment (see
  // payments.spec.ts), so it's an equally reliable signal that payment
  // succeeded.
  await expect(customerPage.getByTestId("booking-confirmation")).toBeVisible();

  await customerPage.getByRole("link", { name: "View my bookings" }).click();
  await expect(customerPage).toHaveURL(/\/bookings$/);
  await customerPage.getByTestId("booking-row").filter({ hasText: "Checkup" }).click();
  await expect(customerPage).toHaveURL(/\/bookings\/[^/]+$/);
  const bookingUrl = customerPage.url();

  // The provider marks the appointment complete — the necessary
  // prerequisite for review eligibility.
  await ownerPage.goto(providerUrl);
  const bookingRow = ownerPage.getByTestId("provider-booking-row").filter({ hasText: "Checkup" });
  ownerPage.once("dialog", (dialog) => dialog.accept());
  await bookingRow.getByTestId("provider-booking-complete-button").click();
  await expect(bookingRow).toContainText("COMPLETED");

  return { owner, businessName, providerUrl, customer, bookingUrl };
}

test("customer workflow: completed booking -> write a review -> review visible -> write action replaced by the existing review", async ({
  browser,
}) => {
  test.slow();
  const ownerContext = await browser.newContext();
  const customerContext = await browser.newContext();

  try {
    const ownerPage = await ownerContext.newPage();
    const customerPage = await customerContext.newPage();
    const { bookingUrl, providerUrl } = await setupCompletedBooking(ownerPage, customerPage, "customer-flow");

    await customerPage.goto(bookingUrl);
    await expect(customerPage.getByTestId("booking-status")).toHaveText("COMPLETED");

    const reviewPanel = customerPage.getByTestId("review-panel");
    await expect(reviewPanel).toBeVisible();
    const form = reviewPanel.getByTestId("review-form");
    await expect(form).toBeVisible();

    await form.getByTestId("star-rating-5").click();
    await form.getByLabel("Title (optional)").fill("Excellent care");
    await form.getByLabel("Comment (optional)").fill("Very professional and helpful.");
    await form.getByTestId("review-submit-button").click();

    // The write form is replaced by the read view of the review that was
    // just created — "Write a review" is no longer offered for this
    // booking.
    await expect(reviewPanel.getByTestId("review-title")).toHaveText("Excellent care");
    await expect(reviewPanel.getByTestId("verified-booking-badge")).toBeVisible();
    await expect(reviewPanel.getByTestId("review-form")).toHaveCount(0);
    await expect(reviewPanel.getByTestId("edit-review-button")).toBeVisible();

    // Reloading the page still shows the existing review, never a second
    // blank write form.
    await customerPage.reload();
    await expect(customerPage.getByTestId("review-panel").getByTestId("review-title")).toHaveText("Excellent care");
    await expect(customerPage.getByTestId("review-panel").getByTestId("review-form")).toHaveCount(0);

    // The provider's public rating updated too.
    await customerPage.goto(providerUrl);
    await expect(customerPage.getByTestId("provider-rating-headline")).toContainText("5.00");
    await expect(customerPage.getByTestId("provider-rating-headline")).toContainText("1 review");
  } finally {
    await ownerContext.close();
    await customerContext.close();
  }
});

test("provider workflow: new customer review appears on the provider profile with aggregate rating updated, no private customer info shown", async ({
  browser,
}) => {
  test.slow();
  const ownerContext = await browser.newContext();
  const customerContext = await browser.newContext();

  try {
    const ownerPage = await ownerContext.newPage();
    const customerPage = await customerContext.newPage();
    const { bookingUrl, providerUrl, customer } = await setupCompletedBooking(ownerPage, customerPage, "provider-flow");

    await customerPage.goto(bookingUrl);
    const form = customerPage.getByTestId("review-panel").getByTestId("review-form");
    await form.getByTestId("star-rating-4").click();
    await form.getByLabel("Comment (optional)").fill("Solid experience overall.");
    await form.getByTestId("review-submit-button").click();
    await expect(customerPage.getByTestId("review-panel").getByTestId("review-comment")).toHaveText(
      "Solid experience overall.",
    );

    await ownerPage.goto(providerUrl);
    const reviewsSection = ownerPage.getByTestId("provider-reviews-section");
    await expect(reviewsSection).toBeVisible();
    await expect(reviewsSection.getByTestId("provider-reviews-list")).toContainText("Solid experience overall.");
    await expect(ownerPage.getByTestId("provider-rating-headline")).toContainText("4.00");
    await expect(ownerPage.getByTestId("provider-rating-headline")).toContainText("1 review");

    // No private customer information (email, raw account id) is ever
    // shown in the public review row.
    const pageContent = await reviewsSection.textContent();
    expect(pageContent).not.toContain(customer.email);
  } finally {
    await ownerContext.close();
    await customerContext.close();
  }
});
