import { expect, test } from "@playwright/test";
import { createCommunity, expectNoA11yViolations, newUserPage, signUp } from "./helpers";

test("Voice requires deliberate join consent and existing messaging setup", async ({ browser }) => {
  const page = await newUserPage(browser);
  try {
    await signUp(page, "Voice Prerequisite"); await createCommunity(page, "Voice consent");
    await page.getByRole("button", { name: "Create channel", exact: true }).click();
    await page.getByLabel("Channel name").fill("consent");
    await page.getByRole("radio", { name: /Voice/ }).check();
    await page.getByRole("dialog").getByRole("button", { name: "Create channel" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "consent" })).toBeVisible();
    await page.getByRole("button", { name: "Join voice", exact: true }).click();
    await expect(page.getByRole("region", { name: "Voice join consent" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel joining Voice" }).click();
    await expect(page.getByRole("region", { name: "Full Voice audience" })).toHaveCount(0);
    await page.getByRole("button", { name: "Join voice", exact: true }).click();
    await page.getByRole("button", { name: "Create temporary device and join" }).click();
    await expect(page.getByRole("link", { name: "Open encrypted messages — Devices and recovery" })).toBeVisible();
    await expectNoA11yViolations(page);
  } finally { await page.context().close(); }
});
