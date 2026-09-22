import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

// This is the mandatory cross-user authorization proof: a passing UI test
// alone doesn't demonstrate the API rejects unauthorized access, since a
// well-behaved UI simply never asks for another user's data. Here User B
// deliberately requests User A's pet, both through the UI and directly
// against the API, to prove the server itself enforces ownership.
test("a pet created by one user is inaccessible to another user", async ({ browser }) => {
  const userAContext = await browser.newContext();
  const userBContext = await browser.newContext();

  try {
    const pageA = await userAContext.newPage();
    const userA = uniqueTestUser("security-a");
    await registerViaUI(pageA, userA);

    await pageA.getByRole("link", { name: "My Pets" }).click();
    await pageA.getByRole("button", { name: "Add Pet", exact: true }).click();
    await pageA.getByLabel("Name").fill("User A's Pet");
    await pageA.getByLabel("Species").fill("Cat");
    await pageA.getByRole("button", { name: "Add Pet", exact: true }).click();
    await pageA.getByTestId("pet-name").click();
    await expect(pageA).toHaveURL(/\/pets\/[^/]+$/);
    const petAUrl = pageA.url();
    const petAId = petAUrl.split("/pets/")[1];

    const pageB = await userBContext.newPage();
    const userB = uniqueTestUser("security-b");
    await registerViaUI(pageB, userB);

    // UI-level proof: navigating straight to User A's pet as User B shows
    // "not found", not User A's data.
    await pageB.goto(`/pets/${petAId}`);
    await expect(pageB.getByTestId("pet-not-found")).toBeVisible();

    // API-level proof: the same denial holds even bypassing the UI
    // entirely, directly against the backend with User B's session cookie.
    const apiBase = process.env.VITE_API_URL ?? "http://localhost:3000";
    const getRes = await pageB.request.get(`${apiBase}/api/pets/${petAId}`);
    expect(getRes.status()).toBe(404);

    const patchRes = await pageB.request.patch(`${apiBase}/api/pets/${petAId}`, {
      data: { name: "Hijacked" },
    });
    expect(patchRes.status()).toBe(404);

    const deleteRes = await pageB.request.delete(`${apiBase}/api/pets/${petAId}`);
    expect(deleteRes.status()).toBe(404);

    // Confirm User A's pet is untouched by the attempted attacks.
    await pageA.reload();
    await expect(pageA.getByTestId("pet-detail-name")).toHaveText("User A's Pet");
  } finally {
    await userAContext.close();
    await userBContext.close();
  }
});
