import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

function futureMonday(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 2);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Mandatory cross-user authorization proof, mirroring every other
// resource's *-security.spec.ts: User A books an appointment; User B —
// a completely different customer, logged in as themselves — must not
// be able to view or cancel it, either through the UI or directly
// against the API with their own valid session.
test("a booking made by one customer cannot be viewed or cancelled by another customer", async ({ browser }) => {
  // This spec drives three separate browser contexts through a full
  // provider+service+availability+pet+booking setup sequentially before
  // the actual security assertions — legitimately heavier than most
  // specs, so it gets explicit headroom under full-suite parallel load
  // rather than relying on running in isolation to stay under the
  // default timeout.
  test.slow();
  const ownerContext = await browser.newContext();
  const customerAContext = await browser.newContext();
  const customerBContext = await browser.newContext();

  try {
    const ownerPage = await ownerContext.newPage();
    const owner = uniqueTestUser("booking-security-owner");
    await registerViaUI(ownerPage, owner);

    const businessName = `Booking Security Clinic ${Date.now()}`;
    await ownerPage.goto("/providers");
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();
    const providerForm = ownerPage.locator("form");
    await providerForm.getByLabel("Business name").fill(businessName);
    await ownerPage.getByRole("button", { name: "Add Provider", exact: true }).click();
    await ownerPage.getByTestId("provider-name").filter({ hasText: businessName }).click();
    await expect(ownerPage).toHaveURL(/\/providers\/[^/]+$/);
    const providerUrl = ownerPage.url();
    const providerId = providerUrl.split("/providers/")[1];

    await ownerPage.getByRole("button", { name: "Add Service", exact: true }).click();
    const serviceForm = ownerPage.locator("form").last();
    await serviceForm.getByLabel("Name").fill("Checkup");
    await serviceForm.getByLabel("Duration (minutes)").fill("30");
    await serviceForm.getByLabel("Price").fill("300");
    await ownerPage.getByRole("button", { name: "Add Service", exact: true }).click();
    await expect(ownerPage.getByTestId("services-list")).toContainText("Checkup");
    const servicesRes = await ownerPage.request.get(
      `${process.env.VITE_API_URL ?? "http://localhost:3000"}/api/providers/${providerId}/services`,
    );
    const { services } = (await servicesRes.json()) as { services: Array<{ id: string }> };
    const serviceId = services[0].id;

    await ownerPage.getByTestId("weekly-rules-manager").getByRole("button", { name: "Add window" }).click();
    const ruleForm = ownerPage.getByTestId("weekly-rules-manager").locator("form");
    await ruleForm.getByLabel("Day").selectOption("MONDAY");
    await ruleForm.getByLabel("Start").fill("09:00");
    await ruleForm.getByLabel("End").fill("10:00");
    await ruleForm.getByRole("button", { name: "Save" }).click();
    await expect(ownerPage.getByTestId("rules-list")).toContainText("MONDAY");

    // Customer A books.
    const pageA = await customerAContext.newPage();
    const customerA = uniqueTestUser("booking-security-a");
    await registerViaUI(pageA, customerA);

    await pageA.goto("/pets");
    await pageA.getByRole("button", { name: "Add Pet", exact: true }).click();
    const petForm = pageA.locator("form");
    await petForm.getByLabel("Name").fill("PetA");
    await petForm.getByLabel("Species").fill("Dog");
    await pageA.getByRole("button", { name: "Add Pet", exact: true }).click();
    await expect(pageA.getByTestId("pets-list")).toContainText("PetA");

    const monday = futureMonday();
    await pageA.goto(providerUrl);
    const picker = pageA.getByTestId("slot-picker");
    await picker.getByLabel("Service").selectOption({ label: "Checkup (30 min)" });
    await picker.getByLabel("Date").fill(monday);
    await pageA.getByTestId("slot-button").filter({ hasText: "09:00" }).click();
    const confirmPanel = pageA.getByTestId("booking-confirm-panel");
    await confirmPanel.getByLabel("Pet").selectOption({ label: "PetA" });
    await confirmPanel.getByRole("button", { name: "Confirm Booking" }).click();

    const paymentPanel = pageA.getByTestId("payment-panel");
    await expect(paymentPanel).toBeVisible();
    await paymentPanel.getByTestId("pay-success-button").click();
    await expect(paymentPanel.getByTestId("payment-status-succeeded")).toBeVisible({ timeout: 15_000 });

    await expect(pageA.getByTestId("booking-confirmation")).toBeVisible();

    await pageA.getByRole("link", { name: "View my bookings" }).click();
    await pageA.getByTestId("booking-row").filter({ hasText: "Checkup" }).click();
    await expect(pageA).toHaveURL(/\/bookings\/[^/]+$/);
    const bookingId = pageA.url().split("/bookings/")[1];

    // Customer B — a different, unrelated customer.
    const pageB = await customerBContext.newPage();
    const customerB = uniqueTestUser("booking-security-b");
    await registerViaUI(pageB, customerB);

    // UI-level proof: navigating straight to User A's booking shows
    // "not found", not User A's data.
    await pageB.goto(`/bookings/${bookingId}`);
    await expect(pageB.getByTestId("booking-not-found")).toBeVisible();

    // API-level proof: the same denial holds directly against the
    // backend with User B's own valid session cookie.
    const apiBase = process.env.VITE_API_URL ?? "http://localhost:3000";
    const getRes = await pageB.request.get(`${apiBase}/api/bookings/${bookingId}`);
    expect(getRes.status()).toBe(404);

    const cancelRes = await pageB.request.post(`${apiBase}/api/bookings/${bookingId}/cancel`);
    expect(cancelRes.status()).toBe(404);

    // User B also cannot book using User A's pet id, nor plant a booking
    // impersonating User A's customer identity.
    const petsARes = await pageA.request.get(`${apiBase}/api/pets`);
    const { pets: petAList } = (await petsARes.json()) as { pets: Array<{ id: string }> };
    const petAId = petAList[0].id;

    const stolenPetRes = await pageB.request.post(`${apiBase}/api/bookings`, {
      data: { providerId, serviceId, petId: petAId, startAt: `${monday}T09:30:00+00:00` },
    });
    expect(stolenPetRes.status()).toBe(404);

    // Confirm User A's booking is completely untouched.
    await pageA.reload();
    await expect(pageA.getByTestId("booking-status")).toHaveText("CONFIRMED");
  } finally {
    await ownerContext.close();
    await customerAContext.close();
    await customerBContext.close();
  }
});
