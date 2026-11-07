import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, newUserPage, signUp } from "./helpers";

test("a new account walks through the onboarding and lands on Home", async ({ browser, browserName }) => {
  test.setTimeout(60_000);
  const page = await newUserPage(browser);
  try {
    // Only Chromium lets a test grant clipboard access; elsewhere the copy buttons are checked for feedback only.
    const clipboard = browserName === "chromium";
    if (clipboard) await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await signUp(page, "Olli Onboarding", "/sign-up", { onboarding: true });

    await expect(page.getByRole("heading", { level: 1, name: "Set up your profile" })).toBeVisible();
    await expect(page.getByLabel("Display name")).toHaveValue("Olli Onboarding");
    await expectNoA11yViolations(page);
    // Not saved by hand: Next saves it.
    await page.getByLabel("Custom status").fill("Just arrived");
    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Make it yours" })).toBeFocused();
    await page.getByText("Midnight").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
    await expectNoA11yViolations(page);
    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Bring your friends" })).toBeVisible();
    const link = await page.getByLabel("Your friend link").inputValue();
    expect(link).toMatch(/\/app\?add=/);
    if (clipboard) {
      await page.getByRole("button", { name: "Copy link" }).click();
      await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
      await page.getByRole("button", { name: "Copy message for Discord" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(link);
    }
    await expect(page.getByRole("link", { name: "WhatsApp" })).toHaveAttribute("href", /^https:\/\/wa\.me\//);
    await page.getByRole("button", { name: "Show QR code" }).click();
    await expect(page.getByRole("img", { name: "QR code for your friend link" })).toBeVisible();
    await expectNoA11yViolations(page);
    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.getByRole("region", { name: "Find your people" }).getByRole("button", { name: "Create a community" })).toBeVisible();
    await expectNoA11yViolations(page);
    await page.getByRole("link", { name: "Let's go" }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("heading", { level: 1, name: "Friends" })).toBeVisible();

    await page.goto("/app/settings");
    await expect(page.getByLabel("Custom status")).toHaveValue("Just arrived");
  } finally {
    await page.context().close();
  }
});

test("sign-ups headed to an invite or a friend link skip the onboarding", async ({ browser, isMobile }) => {
  test.skip(isMobile, "the invite helper drives the desktop sidebar");
  const owner = await newUserPage(browser);
  const friend = await newUserPage(browser);
  const guest = await newUserPage(browser);
  try {
    await signUp(owner, "Owen Owner");
    await createCommunity(owner, "Onboard Hall");
    const invitePath = await createInviteLink(owner);

    await signUp(guest, "Gil Guest", `/sign-up?next=${encodeURIComponent(invitePath)}`, { onboarding: true });
    await expect(guest.getByRole("button", { name: "Accept invite" })).toBeVisible();

    await signUp(friend, "Fay Friend", `/sign-up?next=${encodeURIComponent("/app?add=some-friend-code")}`, { onboarding: true });
    await expect(friend.getByLabel("Friend code")).toHaveValue("some-friend-code");
  } finally {
    await Promise.all([owner.context().close(), friend.context().close(), guest.context().close()]);
  }
});
