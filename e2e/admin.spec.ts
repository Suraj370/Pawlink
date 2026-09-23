import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";
import { promoteToAdminByEmail } from "./db";

function futureMonday(offsetWeeks = 0): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 2);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + offsetWeeks * 7);
  return d.toISOString().slice(0, 10);
}

async function loginAsAdmin(page: import("@playwright/test").Page, label: string) {
  const admin = uniqueTestUser(`${label}-admin`);
  await registerViaUI(page, admin);
  await promoteToAdminByEmail(admin.email);
  // The session cookie was already issued for the pre-promotion role;
  // reload so the next request re-resolves the (now-ADMIN) role from the
  // database, exactly as any real request would.
  await page.reload();
  return admin;
}

async function setupProvider(
  ownerPage: import("@playwright/test").Page,
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
  const providerId = providerUrl.split("/providers/")[1];

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

  return { owner, businessName, providerUrl, providerId };
}

async function bookAndCompleteAndReview(
  ownerPage: import("@playwright/test").Page,
  customerPage: import("@playwright/test").Page,
  providerUrl: string,
  label: string,
  reviewComment: string,
) {
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
  await expect(customerPage.getByTestId("booking-confirmation")).toBeVisible();

  await customerPage.getByRole("link", { name: "View my bookings" }).click();
  await customerPage.getByTestId("booking-row").filter({ hasText: "Checkup" }).click();
  const bookingUrl = customerPage.url();

  await ownerPage.goto(providerUrl);
  const bookingRow = ownerPage.getByTestId("provider-booking-row").filter({ hasText: "Checkup" });
  ownerPage.once("dialog", (dialog) => dialog.accept());
  await bookingRow.getByTestId("provider-booking-complete-button").click();
  await expect(bookingRow).toContainText("COMPLETED");

  await customerPage.goto(bookingUrl);
  const form = customerPage.getByTestId("review-panel").getByTestId("review-form");
  await form.getByTestId("star-rating-5").click();
  await form.getByLabel("Comment (optional)").fill(reviewComment);
  await form.getByTestId("review-submit-button").click();
  await expect(customerPage.getByTestId("review-panel").getByTestId("review-comment")).toHaveText(reviewComment);

  return { customer };
}

test("admin provider suspension workflow: dashboard -> providers -> suspend -> audit event -> no longer bookable by customers", async ({
  browser,
}) => {
  test.slow();
  const adminContext = await browser.newContext();
  const ownerContext = await browser.newContext();
  const customerContext = await browser.newContext();

  try {
    const adminPage = await adminContext.newPage();
    const ownerPage = await ownerContext.newPage();
    const customerPage = await customerContext.newPage();

    await loginAsAdmin(adminPage, "suspend-flow");
    const { businessName, providerUrl } = await setupProvider(ownerPage, "suspend-flow");

    await adminPage.goto("/admin");
    await expect(adminPage.getByTestId("admin-dashboard")).toBeVisible();
    const beforeActive = Number(
      (await adminPage.getByTestId("admin-metric-activeProviders").locator("p").first().textContent()) ?? "0",
    );

    await adminPage.getByRole("link", { name: "Providers" }).click();
    await expect(adminPage).toHaveURL(/\/admin\/providers$/);
    await adminPage.getByTestId("admin-provider-search").fill(businessName);
    const providerRow = adminPage.getByTestId("admin-provider-row").filter({ hasText: businessName });
    await expect(providerRow).toBeVisible();

    adminPage.once("dialog", (dialog) => dialog.accept());
    await providerRow.getByTestId("admin-provider-set-SUSPENDED").click();
    await expect(providerRow).toContainText("SUSPENDED");

    // Dashboard reflects it.
    await adminPage.goto("/admin");
    const afterActive = Number(
      (await adminPage.getByTestId("admin-metric-activeProviders").locator("p").first().textContent()) ?? "0",
    );
    expect(afterActive).toBeLessThanOrEqual(beforeActive);

    // The audit event appears.
    await adminPage.getByRole("link", { name: "Audit Log" }).click();
    await expect(adminPage).toHaveURL(/\/admin\/audit$/);
    await adminPage.locator("select").selectOption("PROVIDER_STATUS_CHANGED");
    await expect(adminPage.getByTestId("admin-audit-list")).toContainText("PROVIDER_STATUS_CHANGED");

    // No longer bookable/visible through the customer UI.
    await customerPage.goto(providerUrl);
    await expect(customerPage.getByTestId("provider-not-found")).toBeVisible();
  } finally {
    await adminContext.close();
    await ownerContext.close();
    await customerContext.close();
  }
});

test("admin review moderation workflow: hide -> not public -> republish -> public again, with audit events", async ({
  browser,
}) => {
  test.slow();
  const adminContext = await browser.newContext();
  const ownerContext = await browser.newContext();
  const customerContext = await browser.newContext();

  try {
    const adminPage = await adminContext.newPage();
    const ownerPage = await ownerContext.newPage();
    const customerPage = await customerContext.newPage();

    await loginAsAdmin(adminPage, "moderation-flow");
    const { providerUrl } = await setupProvider(ownerPage, "moderation-flow");
    const reviewComment = `Moderation target review ${Date.now()}`;
    await bookAndCompleteAndReview(ownerPage, customerPage, providerUrl, "moderation-flow", reviewComment);

    // Publicly visible before moderation.
    await customerPage.goto(providerUrl);
    await expect(customerPage.getByTestId("provider-reviews-list")).toContainText(reviewComment);

    // Every step below deliberately stays on the unfiltered ("All
    // statuses"/"All actions") view of each list — filtering by status
    // is proven separately at the API layer (admin.test.ts), and mixing
    // filter-dropdown interactions into this workflow proof only adds
    // fragility: republishing a row while a HIDDEN filter is active
    // would correctly make it disappear from that filtered view instead
    // of updating in place, which isn't what this test is checking.
    await adminPage.goto("/admin/reviews");
    const reviewRow = adminPage.getByTestId("admin-review-row").filter({ hasText: reviewComment });
    await expect(reviewRow).toBeVisible();
    await reviewRow.getByTestId("admin-review-hide-button").click();
    await expect(reviewRow).toContainText("HIDDEN");

    await customerPage.reload();
    // The list itself doesn't render at all once it's empty (see
    // ProviderReviewsList.tsx) — assert against the whole section
    // instead, which covers both "list gone" and "list present without
    // this review."
    await expect(customerPage.getByTestId("provider-reviews-section")).not.toContainText(reviewComment);

    await adminPage.goto("/admin/audit");
    await expect(adminPage.getByTestId("admin-audit-list")).toContainText("ADMIN_REVIEW_HIDDEN");

    await adminPage.goto("/admin/reviews");
    const reviewRowAgain = adminPage.getByTestId("admin-review-row").filter({ hasText: reviewComment });
    await expect(reviewRowAgain).toContainText("HIDDEN");
    await reviewRowAgain.getByTestId("admin-review-publish-button").click();
    await expect(reviewRowAgain).toContainText("PUBLISHED");

    await customerPage.reload();
    await expect(customerPage.getByTestId("provider-reviews-list")).toContainText(reviewComment);

    await adminPage.goto("/admin/audit");
    await expect(adminPage.getByTestId("admin-audit-list")).toContainText("ADMIN_REVIEW_PUBLISHED");
  } finally {
    await adminContext.close();
    await ownerContext.close();
    await customerContext.close();
  }
});

test("admin security: non-admins are denied both the /admin UI and direct /api/admin calls", async ({ browser }) => {
  const customerContext = await browser.newContext();
  const ownerContext = await browser.newContext();

  try {
    const customerPage = await customerContext.newPage();
    const customer = uniqueTestUser("admin-security-customer");
    await registerViaUI(customerPage, customer);
    await customerPage.goto("/admin");
    await expect(customerPage).toHaveURL(/\/dashboard$/);
    await expect(customerPage.getByTestId("admin-nav-link")).toHaveCount(0);

    const customerApiRes = await customerPage.request.get("http://localhost:3000/api/admin/providers");
    expect(customerApiRes.status()).toBe(403);

    const ownerPage = await ownerContext.newPage();
    const owner = uniqueTestUser("admin-security-owner");
    await registerViaUI(ownerPage, owner);
    await ownerPage.goto("/providers");
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();
    const providerForm = ownerPage.locator("form");
    await providerForm.getByLabel("Business name").fill(`Denied Vet ${Date.now()}`);
    await providerForm.getByLabel("Provider type").selectOption("VET");
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();

    await ownerPage.goto("/admin");
    await expect(ownerPage).toHaveURL(/\/dashboard$/);

    const ownerApiRes = await ownerPage.request.get("http://localhost:3000/api/admin/audit");
    expect(ownerApiRes.status()).toBe(403);
  } finally {
    await customerContext.close();
    await ownerContext.close();
  }
});
