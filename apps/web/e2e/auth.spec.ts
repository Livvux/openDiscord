import { expect, test } from "@playwright/test";

test("protected app redirects anonymous visitors to sign-in", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("sign up, sign out and sign back in", async ({ page }, testInfo) => {
  const email = `e2e-${testInfo.project.name}-${Date.now()}@example.test`;
  const password = "correct horse battery";

  await page.goto("/sign-up");
  await page.getByLabel("Display name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText("E2E Tester")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  // Next keeps the previously visited route mounted but hidden, so scope to the visible form.
  const form = page.locator("form:visible");
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill("wrong password!!");
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(form.getByRole("alert")).toBeVisible();

  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText("E2E Tester")).toBeVisible();
});
