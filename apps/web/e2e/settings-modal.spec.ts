import { expect, test } from "@playwright/test";
import { createCommunity, expectNoA11yViolations, newUserPage, openAccountSettings, signUp } from "./helpers";

test("user settings preserve the chat and close after category changes", async ({ browser, isMobile }, testInfo) => {
  const page = await newUserPage(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 500) errors.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`); });
  await signUp(page, "Modal Member");
  await createCommunity(page, "Modal Community");
  const channelUrl = page.url();
  const composer = page.getByRole("textbox", { name: "Message #general" });
  await composer.fill("Unsent draft survives settings");
  await expect(page.locator('img[src="/brand/symbol-white.svg"]')).toHaveAttribute("src", "/brand/symbol-white.svg");

  await openAccountSettings(page);
  const dialog = page.getByRole("dialog", { name: "User settings", exact: true });
  const nav = dialog.getByRole("navigation", { name: "Settings categories" });
  await expect(dialog.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Theme", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Profile", exact: true })).toBeHidden();
  await expect(nav.getByRole("button", { name: "Appearance", exact: true })).toHaveAttribute("aria-current", "page");
  await expectNoA11yViolations(page);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("user-settings.png") });
  await nav.getByRole("button", { name: "My profile", exact: true }).click();
  await dialog.getByLabel("Display name").fill("Updated Modal Member");
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/auth/update-user") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog.getByRole("status")).toHaveText("Saved.");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(channelUrl);
  await expect(composer).toHaveValue("Unsent draft survives settings");
  await page.goForward();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(page).toHaveURL(channelUrl);
  if (isMobile) {
    const toggle = page.getByRole("button", { name: "Open navigation" });
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  }
  await page.getByRole("link", { name: "Community settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Community settings", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(channelUrl);
  expect(errors).toEqual([]);
  await page.context().close();
});

test("community settings provide categories, reload safely and support direct links", async ({ browser, isMobile }, testInfo) => {
  const page = await newUserPage(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 500) errors.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`); });
  await signUp(page, "Modal Owner");
  await createCommunity(page, "Settings Server");
  const channelUrl = page.url();
  if (isMobile) await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Community settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Community settings", exact: true });
  const nav = dialog.getByRole("navigation", { name: "Settings categories" });
  await expect(dialog.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "Roles", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Roles", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Overview", exact: true })).toBeHidden();
  await expectNoA11yViolations(page);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("server-settings.png") });
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(channelUrl);

  const communityPath = new URL(channelUrl).pathname.split("/").slice(0, 4).join("/");
  await page.goto(`${communityPath}/settings#members-heading`);
  await expect(dialog.getByRole("heading", { name: /^Members \(/ })).toBeVisible();
  await page.reload();
  await expect(dialog.getByRole("heading", { name: /^Members \(/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(page).toHaveURL(channelUrl);
  expect(errors).toEqual([]);
  await page.context().close();
});
