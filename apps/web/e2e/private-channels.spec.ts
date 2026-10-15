import { expect, test } from "@playwright/test";
import { createChannel, createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, sendMessage, signUp } from "./helpers";

test.describe("private channels", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("a channel hidden from everyone disappears for members, live and by URL", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Priya Private");
    await createCommunity(owner, "Back Office");
    const invitePath = await createInviteLink(owner);
    const member = await joinAsNewUser(browser, "Mo Member", invitePath);

    await createChannel(owner, "staff-room");
    const staffUrl = owner.url();
    await expect(member.getByRole("link", { name: "staff-room" })).toBeVisible();

    await owner.getByRole("button", { name: "Channel settings" }).click();
    const dialog = owner.getByRole("dialog");
    const viewForEveryone = dialog.getByLabel("View for everyone");
    await expect(viewForEveryone).toBeVisible();
    await expectNoA11yViolations(owner);
    await viewForEveryone.selectOption("deny");
    await expect(dialog.getByText("Private: only roles allowed to view can see this channel.")).toBeVisible();
    await owner.keyboard.press("Escape");
    await expect(owner.getByRole("link", { name: "staff-room (private)" })).toBeVisible();

    // The member's sidebar updates without a reload, and the URL no longer resolves.
    await expect(member.getByRole("link", { name: /staff-room/ })).toHaveCount(0);
    await sendMessage(owner, "salary review on friday");
    await member.goto(staffUrl);
    await expect(member.getByText(/could not be found/i)).toBeVisible();
    await expect(member.getByText("salary review on friday")).toHaveCount(0);
    const api = await member.request.get(`/api/channels/${staffUrl.split("/").pop()}/messages`);
    expect(api.status()).toBe(404);
  });
});
