import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

// Mandatory cross-user authorization proof, mirroring
// pets-security.spec.ts and providers-security.spec.ts: a passing UI test
// alone doesn't demonstrate the API rejects unauthorized modification,
// since a well-behaved UI simply never offers the controls. Here User B
// deliberately targets a service under User A's provider, both through
// the UI and directly against the API.
test("a service created under one user's provider cannot be modified by another user", async ({ browser }) => {
  const userAContext = await browser.newContext();
  const userBContext = await browser.newContext();

  try {
    const pageA = await userAContext.newPage();
    const userA = uniqueTestUser("service-security-a");
    await registerViaUI(pageA, userA);

    const businessName = `User A's Provider ${Date.now()}`;
    await pageA.goto("/providers");
    await pageA.getByRole("button", { name: "Add Provider", exact: true }).click();
    const providerForm = pageA.locator("form");
    await providerForm.getByLabel("Business name").fill(businessName);
    await pageA.getByRole("button", { name: "Add Provider", exact: true }).click();
    await pageA.getByTestId("provider-name").filter({ hasText: businessName }).click();
    await expect(pageA).toHaveURL(/\/providers\/[^/]+$/);
    const providerId = pageA.url().split("/providers/")[1];

    await pageA.getByRole("button", { name: "Add Service", exact: true }).click();
    const serviceForm = pageA.locator("form").last();
    await serviceForm.getByLabel("Name").fill("Service A");
    await serviceForm.getByLabel("Duration (minutes)").fill("45");
    await serviceForm.getByLabel("Price").fill("500");
    await pageA.getByRole("button", { name: "Add Service", exact: true }).click();
    const serviceRow = pageA.getByTestId("service-row").filter({ hasText: "Service A" });
    await expect(serviceRow).toBeVisible();

    const apiBase = process.env.VITE_API_URL ?? "http://localhost:3000";
    const listRes = await pageA.request.get(`${apiBase}/api/providers/${providerId}/services`);
    const listJson = (await listRes.json()) as { services: Array<{ id: string; name: string }> };
    const serviceAId = listJson.services.find((s) => s.name === "Service A")!.id;

    const pageB = await userBContext.newPage();
    const userB = uniqueTestUser("service-security-b");
    await registerViaUI(pageB, userB);

    // UI-level proof: User B can see the service (it's public) but gets
    // no owner controls anywhere on the page.
    await pageB.goto(`/providers/${providerId}`);
    await expect(pageB.getByTestId("service-row").filter({ hasText: "Service A" })).toBeVisible();
    await expect(pageB.getByRole("button", { name: "Add Service" })).not.toBeVisible();
    await expect(pageB.getByTestId("service-row").getByRole("button", { name: "Edit" })).not.toBeVisible();
    await expect(pageB.getByTestId("service-row").getByRole("button", { name: "Deactivate" })).not.toBeVisible();

    // API-level proof: the same denial holds directly against the
    // backend with User B's own valid session cookie.
    const patchRes = await pageB.request.patch(`${apiBase}/api/providers/${providerId}/services/${serviceAId}`, {
      data: { name: "Hijacked" },
    });
    expect(patchRes.status()).toBe(404);

    const deleteRes = await pageB.request.delete(`${apiBase}/api/providers/${providerId}/services/${serviceAId}`);
    expect(deleteRes.status()).toBe(404);

    // User B also cannot plant a new service under User A's provider.
    const createRes = await pageB.request.post(`${apiBase}/api/providers/${providerId}/services`, {
      data: { name: "Planted", durationMinutes: 30, priceMinor: 100 },
    });
    expect(createRes.status()).toBe(404);

    // Confirm Service A (and Provider A) are completely untouched.
    await pageA.reload();
    const untouchedRow = pageA.getByTestId("service-row").filter({ hasText: "Service A" });
    await expect(untouchedRow).toBeVisible();
    await expect(untouchedRow.getByTestId("service-inactive-badge")).toHaveCount(0);
    await expect(pageA.getByTestId("service-row").filter({ hasText: "Planted" })).toHaveCount(0);
  } finally {
    await userAContext.close();
    await userBContext.close();
  }
});
