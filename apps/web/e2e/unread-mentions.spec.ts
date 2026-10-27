import { expect, test } from "@playwright/test";
import { createChannel, createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, signUp, waitForLive } from "./helpers";

test.describe("unread state and mentions", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("a mention badges the channel live, notifies on the desktop and clears when read", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Uma Unread");
    await createCommunity(owner, "Reading Room");
    const invitePath = await createInviteLink(owner);
    await createChannel(owner, "random");
    const member = await joinAsNewUser(browser, "Nia Notified", invitePath);

    // Opt in to desktop notifications; record them instead of showing OS popups.
    await member.context().grantPermissions(["notifications"]);
    await member.addInitScript(() => {
      const shown: string[] = [];
      Object.assign(window, { __shown: shown });
      class FakeNotification {
        static permission = "granted";
        static requestPermission = async () => "granted";
        onclick: (() => void) | null = null;
        constructor(title: string) { shown.push(title); }
        close() {}
      }
      Object.assign(window, { Notification: FakeNotification });
    });
    await member.goto("/app/settings");
    await member.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Notifications", exact: true }).click();
    await member.getByRole("switch", { name: /Desktop notifications/ }).click();
    await expect(member.getByRole("switch", { name: /Desktop notifications/ })).toBeChecked();
    await expectNoA11yViolations(member);
    await member.goBack();
    await expect(member.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
    await waitForLive(member);

    // The owner picks the member from the autocomplete in #random.
    const composer = owner.getByRole("textbox", { name: "Message #random" });
    await composer.fill("hey @Ni");
    await expect(owner.getByRole("option", { name: "@Nia Notified" })).toHaveAttribute("aria-selected", "true");
    await composer.press("Enter");
    await expect(composer).toHaveValue("hey @Nia Notified ");
    await composer.pressSequentially("look at this");
    await composer.press("Enter");
    await expect(owner.getByRole("log").getByText("@Nia Notified")).toBeVisible();

    const randomLink = member.getByRole("link", { name: /random/ });
    await expect(randomLink).toContainText("1");
    await expect(randomLink).toHaveAccessibleName(/1 mention/);
    await expect.poll(() => member.evaluate(() => (window as unknown as { __shown: string[] }).__shown)).toEqual(["Uma Unread in #random"]);

    await randomLink.click();
    const mentioned = member.getByRole("log").getByRole("listitem").filter({ hasText: "look at this" });
    await expect(mentioned.getByText("@Nia Notified")).toBeVisible();
    await expect(member.getByRole("link", { name: /random/ })).not.toHaveAccessibleName(/mention/);

    // Reloading keeps it read (stored on the server).
    await member.reload();
    await expect(member.getByRole("link", { name: /random/ })).not.toHaveAccessibleName(/mention|unread/);
  });
});
