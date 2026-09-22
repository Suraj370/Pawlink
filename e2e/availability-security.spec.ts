import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

// Mandatory cross-user authorization proof, mirroring
// pets/providers/services-security.spec.ts: User A configures weekly
// availability for their own provider; User B, logged in as themselves,
// attempts to modify it — both through the UI (no controls exist for a
// non-owner) and directly against the API.
test("a provider's availability rules cannot be modified by another user", async ({ browser }) => {
  const userAContext = await browser.newContext();
  const userBContext = await browser.newContext();

  try {
    const pageA = await userAContext.newPage();
    const userA = uniqueTestUser("avail-security-a");
    await registerViaUI(pageA, userA);

    const businessName = `User A's Availability Provider ${Date.now()}`;
    await pageA.goto("/providers");
    await pageA.getByRole("button", { name: "Add Provider", exact: true }).click();
    const providerForm = pageA.locator("form");
    await providerForm.getByLabel("Business name").fill(businessName);
    await pageA.getByRole("button", { name: "Add Provider", exact: true }).click();
    await pageA.getByTestId("provider-name").filter({ hasText: businessName }).click();
    await expect(pageA).toHaveURL(/\/providers\/[^/]+$/);
    const providerId = pageA.url().split("/providers/")[1];

    await pageA.getByTestId("weekly-rules-manager").getByRole("button", { name: "Add window" }).click();
    const ruleForm = pageA.getByTestId("weekly-rules-manager").locator("form");
    await ruleForm.getByLabel("Day").selectOption("MONDAY");
    await ruleForm.getByLabel("Start").fill("09:00");
    await ruleForm.getByLabel("End").fill("17:00");
    await ruleForm.getByRole("button", { name: "Save" }).click();
    await expect(pageA.getByTestId("rules-list")).toContainText("MONDAY");

    const apiBase = process.env.VITE_API_URL ?? "http://localhost:3000";
    const rulesRes = await pageA.request.get(`${apiBase}/api/providers/${providerId}/availability/rules`);
    const rulesJson = (await rulesRes.json()) as { rules: Array<{ id: string }> };
    const ruleId = rulesJson.rules[0].id;

    const pageB = await userBContext.newPage();
    const userB = uniqueTestUser("avail-security-b");
    await registerViaUI(pageB, userB);

    // UI-level proof: User B visiting User A's provider sees no
    // availability-management controls at all.
    await pageB.goto(`/providers/${providerId}`);
    await expect(pageB.getByTestId("weekly-rules-manager")).toHaveCount(0);
    await expect(pageB.getByTestId("exceptions-manager")).toHaveCount(0);

    // API-level proof: the same denial holds directly against the
    // backend with User B's own valid session cookie.
    const patchRes = await pageB.request.patch(`${apiBase}/api/providers/${providerId}/availability/rules/${ruleId}`, {
      data: { dayOfWeek: "MONDAY", startTime: "00:00", endTime: "23:59" },
    });
    expect(patchRes.status()).toBe(404);

    const deleteRes = await pageB.request.delete(`${apiBase}/api/providers/${providerId}/availability/rules/${ruleId}`);
    expect(deleteRes.status()).toBe(404);

    const createRes = await pageB.request.post(`${apiBase}/api/providers/${providerId}/availability/rules`, {
      data: { dayOfWeek: "TUESDAY", startTime: "09:00", endTime: "10:00" },
    });
    expect(createRes.status()).toBe(404);

    const exceptionRes = await pageB.request.post(`${apiBase}/api/providers/${providerId}/availability/exceptions`, {
      data: { date: "2031-06-15", type: "CLOSED" },
    });
    expect(exceptionRes.status()).toBe(404);

    // Confirm User A's rule is completely untouched.
    await pageA.reload();
    await expect(pageA.getByTestId("rules-list")).toContainText("MONDAY 09:00–17:00");
  } finally {
    await userAContext.close();
    await userBContext.close();
  }
});
