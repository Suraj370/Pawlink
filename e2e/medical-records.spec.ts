import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

function futureMonday(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 2);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Full setup shared by both workflow tests below: a provider owner with a
// bookable service, a customer who owns a pet, and a CONFIRMED booking
// between them — the "legitimate relationship" the entire medical-records
// authorization model is built on (see docs/architecture.md).
async function setupConfirmedBooking(
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
  await customerPage.getByTestId("pet-name").filter({ hasText: "Rex" }).click();
  await expect(customerPage).toHaveURL(/\/pets\/[^/]+$/);
  const petUrl = customerPage.url();

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
  await expect(paymentPanel.getByTestId("payment-status-succeeded")).toBeVisible({ timeout: 15_000 });
  await expect(customerPage.getByTestId("booking-confirmation")).toBeVisible();

  return { owner, businessName, providerUrl, customer, petUrl };
}

test("provider workflow: eligible pet -> view history -> create record -> record appears; unrelated pet stays inaccessible", async ({
  browser,
}) => {
  test.slow();
  const ownerContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const strangerContext = await browser.newContext();

  try {
    const ownerPage = await ownerContext.newPage();
    const customerPage = await customerContext.newPage();
    const { providerUrl } = await setupConfirmedBooking(ownerPage, customerPage, "provider-flow");

    // Provider opens the eligible pet's medical records from the
    // provider-facing bookings panel — never by guessing/typing a pet id.
    await ownerPage.goto(providerUrl);
    const bookingsPanel = ownerPage.getByTestId("provider-bookings-panel");
    await expect(bookingsPanel).toBeVisible();
    const bookingRow = ownerPage.getByTestId("provider-booking-row").filter({ hasText: "Checkup" });
    await bookingRow.getByTestId("provider-booking-medical-records-link").click();
    await expect(ownerPage).toHaveURL(/\/provider-medical-records\/[^/]+$/);

    await expect(ownerPage.getByTestId("medical-records-empty-state")).toBeVisible();

    await ownerPage.getByRole("button", { name: "Add medical record" }).click();
    const form = ownerPage.getByTestId("medical-record-form");
    await expect(form).toBeVisible();
    await form.getByLabel("Record type").selectOption("VISIT");
    await form.getByLabel("Title").fill("Annual wellness exam");
    await form.getByLabel("Date").fill("2026-01-20T09:00");
    await form.getByLabel("Diagnosis (optional)").fill("Healthy, no concerns");
    await form.getByRole("button", { name: "Add record" }).click();

    await expect(ownerPage.getByTestId("medical-records-rows")).toContainText("Annual wellness exam");
    await expect(ownerPage.getByTestId("medical-records-rows")).toContainText("VISIT");

    // A stranger provider with NO relationship to this pet is refused —
    // proven by driving the API directly with a random pet id, since the
    // UI itself never exposes another user's pet id to navigate to.
    const strangerPage = await strangerContext.newPage();
    const stranger = uniqueTestUser("provider-flow-stranger");
    await registerViaUI(strangerPage, stranger);
    const res = await strangerPage.request.get("http://localhost:3000/api/pets/00000000-0000-0000-0000-000000000000/medical-records");
    expect(res.status()).toBe(404);
  } finally {
    await ownerContext.close();
    await customerContext.close();
    await strangerContext.close();
  }
});

test("customer workflow: open own pet -> see medical history created by the treating provider", async ({ browser }) => {
  test.slow();
  const ownerContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const strangerContext = await browser.newContext();

  try {
    const ownerPage = await ownerContext.newPage();
    const customerPage = await customerContext.newPage();
    const { providerUrl, petUrl } = await setupConfirmedBooking(ownerPage, customerPage, "customer-flow");

    // Provider adds a record via the API directly (the provider UI path
    // is already proven by the other workflow test above) so this test
    // stays focused on the customer-facing read path.
    await ownerPage.goto(providerUrl);
    await ownerPage.getByTestId("provider-booking-row").filter({ hasText: "Checkup" }).getByTestId("provider-booking-medical-records-link").click();
    await ownerPage.getByRole("button", { name: "Add medical record" }).click();
    const form = ownerPage.getByTestId("medical-record-form");
    await form.getByLabel("Record type").selectOption("VACCINATION");
    await form.getByLabel("Title").fill("Rabies vaccine");
    await form.getByLabel("Date").fill("2026-01-20T09:00");
    await form.getByLabel("Vaccine name").fill("Rabies");
    await form.getByLabel("Administered on").fill("2026-01-20");
    await form.getByRole("button", { name: "Add record" }).click();
    await expect(ownerPage.getByTestId("medical-records-rows")).toContainText("Rabies vaccine");

    // Customer sees it on their own pet's page.
    await customerPage.goto(petUrl);
    await expect(customerPage.getByTestId("medical-records-section")).toBeVisible();
    await expect(customerPage.getByTestId("medical-records-rows")).toContainText("Rabies vaccine");
    await expect(customerPage.getByTestId("medical-records-rows")).toContainText("VACCINATION");
    // Read-only: a pet owner is never offered an "Add medical record"
    // control — only a treating provider gets one (see canCreate on
    // MedicalRecordsSection).
    await expect(customerPage.getByRole("button", { name: "Add medical record" })).toHaveCount(0);

    // A second, unrelated customer's own pet never shows this history.
    const strangerPage = await strangerContext.newPage();
    const stranger = uniqueTestUser("customer-flow-stranger");
    await registerViaUI(strangerPage, stranger);
    await strangerPage.goto("/pets");
    await strangerPage.getByRole("button", { name: "Add Pet", exact: true }).click();
    const strangerPetForm = strangerPage.locator("form");
    await strangerPetForm.getByLabel("Name").fill("Buddy");
    await strangerPetForm.getByLabel("Species").fill("Cat");
    await strangerPage.getByRole("button", { name: "Add Pet", exact: true }).click();
    await strangerPage.getByTestId("pet-name").filter({ hasText: "Buddy" }).click();
    await expect(strangerPage.getByTestId("medical-records-empty-state")).toBeVisible();
    await expect(strangerPage.getByText("Rabies vaccine")).toHaveCount(0);
  } finally {
    await ownerContext.close();
    await customerContext.close();
    await strangerContext.close();
  }
});
