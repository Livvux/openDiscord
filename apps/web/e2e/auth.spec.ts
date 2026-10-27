import { expect, test } from "@playwright/test";
import { expectNoA11yViolations, finishSignOut, openAccountSettings } from "./helpers";

test("protected app redirects anonymous visitors to sign-in", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("sign up, sign out and sign back in", async ({ page }, testInfo) => {
  const email = `e2e-${testInfo.project.name}-${Date.now()}@example.test`;
  const password = "correct horse battery";
  // Its own client IP: sign-up limits are per IP and kept in Postgres across runs.
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": `10.251.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });

  await page.goto("/sign-up");
  await expectNoA11yViolations(page);
  await page.getByLabel("Display name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("checkbox", { name: /I am at least/ }).check();
  await expect(page.locator('[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { level: 1, name: "Friends" })).toBeVisible();

  await openAccountSettings(page);
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Devices", exact: true }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await finishSignOut(page);

  // Next keeps the previously visited route mounted but hidden, so scope to the visible form.
  const form = page.locator("form:visible");
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill("wrong password!!");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();

  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { level: 1, name: "Friends" })).toBeVisible();
});
