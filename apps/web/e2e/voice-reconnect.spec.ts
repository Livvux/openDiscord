import { expect, test, type Page } from "@playwright/test";
import { createCommunity, newUserPage, signUp } from "./helpers";

const status = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text }).first();
const waitingAlone = "Waiting for others to join…";

// Pre-media phase only (no SFU connection yet): control HTTP is the whole call. Once media is
// connected, an SDK reconnect stays terminal by design and is covered by the product spec.
test("Voice rides out a short control outage and ends cleanly with Rejoin when the network stays down", async ({ browser, isMobile }) => {
  test.skip(isMobile, "Network behaviour is layout-independent; desktop covers it.");
  test.setTimeout(120_000);
  const page = await newUserPage(browser);
  try {
    await signUp(page, "Voice Reconnect"); await createCommunity(page, "Voice reconnect");
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("opendiscord.dm.ready:"))), { timeout: 20_000 }).toBe(true);
    await page.getByRole("button", { name: "Create channel", exact: true }).click();
    await page.getByLabel("Channel name").fill("reconnect");
    await page.getByRole("radio", { name: /Voice/ }).check();
    await page.getByRole("dialog").getByRole("button", { name: "Create channel" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "reconnect" })).toBeVisible();
    await page.getByRole("button", { name: "Join voice", exact: true }).click();
    await page.getByRole("button", { name: "Create temporary device and join" }).click();
    await expect(status(page, waitingAlone)).toBeVisible({ timeout: 20_000 });

    // A few seconds of failing control requests (poll every second, heartbeat every ten).
    let aborted = 0;
    await page.route("**/api/voice/control", route => { aborted++; return route.abort("internetdisconnected"); });
    await expect(status(page, /^Reconnecting to the voice server…/)).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(3_000);
    await page.unroute("**/api/voice/control");
    expect(aborted).toBeGreaterThan(0);
    await expect(status(page, waitingAlone)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Leave Voice" }).first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /^Voice stopped/ })).toHaveCount(0);

    // Offline past the 30-second lease: a clean, actionable stop, never a silent hang.
    await page.context().setOffline(true);
    await expect(status(page, /^Reconnecting to the voice server…/)).toBeVisible({ timeout: 5_000 });
    await expect(status(page, /^Voice stopped: (the connection to the voice server was interrupted|the call connection expired)/)).toBeVisible({ timeout: 40_000 });
    const rejoin = page.getByRole("button", { name: "Rejoin voice with a new temporary device" });
    await expect(rejoin).toBeVisible();
    await page.context().setOffline(false);
    await rejoin.click();
    await expect(status(page, waitingAlone)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Leave Voice" }).first().click();
  } finally {
    await page.context().close();
  }
});
