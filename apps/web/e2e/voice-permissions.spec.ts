import { expect, test, type Page } from "@playwright/test";
import { createCommunity, newUserPage, signUp } from "./helpers";

// A revoked or denied media permission must surface a clear message instead of hanging.
// Denial is simulated at getUserMedia/getDisplayMedia: Chromium's fake-UI flag and Firefox's prefs auto-accept prompts.
async function denyMedia(page: Page) {
  await page.context().clearPermissions();
  await page.evaluate(() => {
    const deny = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    navigator.mediaDevices.getUserMedia = deny;
    navigator.mediaDevices.getDisplayMedia = deny;
  });
}

test("denied microphone, camera and screen access give a clear message and leave Voice usable", async ({ browser, isMobile, browserName }) => {
  test.skip(isMobile, "desktop channel sidebar");
  test.skip(!process.env.LIVEKIT_URL, "needs a LiveKit SFU");
  const page = await newUserPage(browser);
  if (browserName !== "firefox") await page.context().grantPermissions(["microphone", "camera"]);
  try {
    await signUp(page, "Perm Revoked");
    await createCommunity(page, "Permission club");
    await page.getByRole("button", { name: "Create channel", exact: true }).click();
    await page.getByLabel("Channel name").fill("lounge");
    await page.getByRole("radio", { name: /Voice/ }).check();
    await page.getByRole("dialog").getByRole("button", { name: "Create channel" }).click();
    await page.getByRole("button", { name: "Join voice", exact: true }).click();
    await page.getByRole("button", { name: "Create temporary device and join" }).click();
    const audience = page.getByRole("region", { name: "Full Voice audience", exact: true });
    await audience.getByRole("button", { name: "Allow this audience and prepare encrypted media" }).click({ timeout: 20_000 });
    await expect(page.getByRole("status").filter({ hasText: "Encrypted voice ready — microphone off" }).first()).toBeVisible({ timeout: 20_000 });

    await denyMedia(page);
    const alert = page.getByRole("alert");
    await page.getByRole("button", { name: "Unmute microphone", exact: true }).first().click();
    await expect(alert.filter({ hasText: "Microphone access was blocked" }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Unmute microphone", exact: true }).first()).toBeEnabled();
    await page.getByRole("button", { name: "Camera", exact: true }).first().click();
    await expect(alert.filter({ hasText: "Camera access was blocked" }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Share screen", exact: true }).first().click();
    await expect(alert.filter({ hasText: "Screen sharing was cancelled or blocked" }).first()).toBeVisible({ timeout: 10_000 });
    // Still connected: the session did not hang or drop.
    await expect(page.getByRole("status").filter({ hasText: /Encrypted voice ready/ }).first()).toBeVisible();
  } finally {
    await page.context().close();
  }
});
