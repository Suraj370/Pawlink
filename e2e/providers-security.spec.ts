import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

// Mandatory cross-user authorization proof, mirroring pets-security.spec.ts:
// a passing UI test alone doesn't demonstrate the API rejects unauthorized
// modification, since a well-behaved UI simply never offers the controls.
// Here User B deliberately targets User A's provider, both through the UI
// and directly against the API.
test("a provider created by one user cannot be modified by another user", async ({ browser }) => {
  const userAContext = await browser.newContext();
  const userBContext = await browser.newContext();

  try {
    const pageA = await userAContext.newPage();
    const userA = uniqueTestUser("provider-security-a");
    await registerViaUI(pageA, userA);

    const businessName = `User A's Business ${Date.now()}`;
    await pageA.goto("/providers");
    await pageA.getByRole("button", { name: "Add Provider", exact: true }).click();
    await pageA.getByLabel("Business name").fill(businessName);
    await pageA.getByRole("button", { name: "Add Provider", exact: true }).click();
    await pageA.getByTestId("provider-name").filter({ hasText: businessName }).click();
    await expect(pageA).toHaveURL(/\/providers\/[^/]+$/);
    const providerId = pageA.url().split("/providers/")[1];

    const pageB = await userBContext.newPage();
    const userB = uniqueTestUser("provider-security-b");
    await registerViaUI(pageB, userB);

    // UI-level proof: User B sees the provider (it's public) but gets no
    // owner controls at all.
    await pageB.goto(`/providers/${providerId}`);
    await expect(pageB.getByTestId("provider-detail-name")).toHaveText(businessName);
    await expect(pageB.getByRole("button", { name: "Edit" })).not.toBeVisible();
    await expect(pageB.getByRole("button", { name: "Deactivate" })).not.toBeVisible();

    // API-level proof: the same denial holds directly against the backend
    // with User B's own valid session cookie.
    const apiBase = process.env.VITE_API_URL ?? "http://localhost:3000";
    const patchRes = await pageB.request.patch(`${apiBase}/api/providers/${providerId}`, {
      data: { businessName: "Hijacked" },
    });
    expect(patchRes.status()).toBe(404);

    const suspendRes = await pageB.request.patch(`${apiBase}/api/providers/${providerId}`, {
      data: { status: "SUSPENDED" },
    });
    expect(suspendRes.status()).toBe(400); // not even a legal shape for a non-admin

    const deleteRes = await pageB.request.delete(`${apiBase}/api/providers/${providerId}`);
    expect(deleteRes.status()).toBe(404);

    // Confirm User A's provider is untouched and still ACTIVE.
    await pageA.reload();
    await expect(pageA.getByTestId("provider-detail-name")).toHaveText(businessName);
    await expect(pageA.getByTestId("provider-status")).toHaveText("ACTIVE");
  } finally {
    await userAContext.close();
    await userBContext.close();
  }
});
