import { expect, test } from "@playwright/test";
import { expectNoA11yViolations, newUserPage, signUp } from "./helpers";

// Headless Chromium has no push service, so subscribing always fails here; delivery is covered by
// tests/push.integration.test.ts and needs a manual check in a real browser.
test.describe("web push", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");
  test.skip(!process.env.VAPID_PUBLIC_KEY, "needs VAPID keys");

  test("the opt-in is offered, fails gracefully without a push service, and the worker is served", async ({ browser }) => {
    const page = await newUserPage(browser);
    await page.context().grantPermissions(["notifications"]);
    await signUp(page, "Pat Push");
    await page.goto("/app/settings");
    await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Notifications", exact: true }).click();
    const toggle = page.getByRole("switch", { name: /Push notifications for mentions/ });
    await expectNoA11yViolations(page);
    await toggle.click();
    await expect(page.getByRole("alert").filter({ hasText: /push notifications/i })).toBeVisible();
    await expect(toggle).not.toBeChecked();
    const sw = await page.request.get("/sw.js");
    expect(sw.ok()).toBe(true);
    expect(await sw.text()).toContain("showNotification");
  });
});
