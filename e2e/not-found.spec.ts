import { expect, test, PROJECT } from "./fixtures";

/**
 * Each 404 names what is missing, and only that. The in-app 404 used to say
 * "We couldn't find that issue" on every page, people and projects included.
 */
test.describe("not-found pages", () => {
  test.use({ as: "user" });

  test("an issue that doesn't exist", async ({ page }) => {
    // The issue layout throws this 404 before streaming, so the status is real.
    const response = await page.goto(`${PROJECT}/999999`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: /issue/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /issues/i }).first()).toBeVisible();
  });

  test("a page of the agents directory past the last one", async ({ page }) => {
    // Otherwise search engines index an endless run of empty lists.
    const response = await page.goto("/agents?page=999");
    expect(response?.status()).toBe(404);
  });

  test("a person who doesn't exist", async ({ page }) => {
    await page.goto("/users/no-such-person-e2e");
    await expect(page.getByRole("heading", { name: /person/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /ranking/i }).first()).toBeVisible();
  });

  test("a redesign proposal that doesn't exist", async ({ page }) => {
    await page.goto("/redesigns/no-such-redesign-e2e");
    await expect(page.getByRole("heading", { name: /redesign/i }).first()).toBeVisible();
  });
});
