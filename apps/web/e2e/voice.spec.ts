import { expect, test } from "@playwright/test";
import { createCommunity, expectNoA11yViolations, newUserPage, signUp } from "./helpers";
import { observeVoiceProductResult } from "./fixtures/voice-product-results";

test("Voice requires deliberate join consent and existing messaging setup", async ({ browser, isMobile }) => {
  const page = await newUserPage(browser);
  let primaryFailure = false;
  try {
    await signUp(page, "Voice Prerequisite"); await createCommunity(page, "Voice consent");
    // Home sets up this browser's DM device on its own; drop it once ready to reach the no-messaging-setup state.
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("opendiscord.dm.ready:"))), { timeout: 20_000 }).toBe(true);
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("opendiscord.dm.")) localStorage.removeItem(key); });
    const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
    if (isMobile) {
      if (await navigation.getAttribute("aria-expanded") === "false") await navigation.click();
      await expect(page.getByRole("navigation", { name: "Channels", exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "Create channel", exact: true }).click();
    await page.getByLabel("Channel name").fill("consent");
    await page.getByRole("radio", { name: /Voice/ }).check();
    await page.getByRole("dialog").getByRole("button", { name: "Create channel" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "consent" })).toBeVisible();
    if (isMobile) {
      if (await navigation.getAttribute("aria-expanded") === "true") await page.keyboard.press("Escape");
      await expect(navigation).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("navigation", { name: "Channels", exact: true })).toBeHidden();
    }
    await page.getByRole("button", { name: "Join voice", exact: true }).click();
    await expect(page.getByRole("region", { name: "Voice join consent" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel joining Voice" }).click();
    await expect(page.getByRole("region", { name: "Full Voice audience" })).toHaveCount(0);
    await page.getByRole("button", { name: "Join voice", exact: true }).click();
    await page.getByRole("button", { name: "Create temporary device and join" }).click();
    await expect(page.getByRole("link", { name: "Open encrypted messages — Devices and recovery" })).toBeVisible();
    await expectNoA11yViolations(page);
  } catch (error) {
    primaryFailure = true; throw error;
  } finally {
    const closed = await observeVoiceProductResult(() => page.context().close(), { timeoutMs: 2000, stage: "cleanup" });
    if (!primaryFailure && !closed.ok) throw new Error("Voice prerequisite context cleanup failed.");
  }
});
