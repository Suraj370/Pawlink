import { test, expect } from "@playwright/test";
import { registerViaUI, uniqueTestUser } from "./helpers";

test("add a pet, edit it, verify updates, then delete it", async ({ page }) => {
  const user = uniqueTestUser("pets");
  await registerViaUI(page, user);

  // Open My Pets from the dashboard.
  await page.getByRole("link", { name: "My Pets" }).click();
  await expect(page).toHaveURL(/\/pets$/);
  await expect(page.getByTestId("pets-empty-state")).toBeVisible();

  // Add a pet.
  await page.getByRole("button", { name: "Add Pet", exact: true }).click();
  await page.getByLabel("Name").fill("Fido");
  await page.getByLabel("Species").fill("Dog");
  await page.getByLabel("Breed").fill("Labrador");
  await page.getByLabel("Sex").selectOption("MALE");
  await page.getByLabel("Date of birth").fill("2020-05-01");
  await page.getByLabel("Weight (kg)").fill("25.5");
  await page.getByLabel("Photo URL").fill("https://example.com/fido.jpg");
  await page.getByRole("button", { name: "Add Pet", exact: true }).click();

  // Verify the pet appears in the list.
  const petList = page.getByTestId("pets-list");
  await expect(petList).toBeVisible();
  await expect(petList.getByTestId("pet-name")).toHaveText("Fido");

  // Open pet details.
  await petList.getByTestId("pet-name").click();
  await expect(page).toHaveURL(/\/pets\/[^/]+$/);
  await expect(page.getByTestId("pet-detail-name")).toHaveText("Fido");

  // Edit the pet.
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Name").fill("Fido Updated");
  await page.getByLabel("Weight (kg)").fill("30");
  await page.getByRole("button", { name: "Save changes" }).click();

  // Verify updated information.
  await expect(page.getByTestId("pet-detail-name")).toHaveText("Fido Updated");
  await expect(page.getByText("30 kg")).toBeVisible();

  // Delete the pet.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete" }).click();

  // Verify the pet is gone.
  await expect(page).toHaveURL(/\/pets$/);
  await expect(page.getByTestId("pets-empty-state")).toBeVisible();
});
