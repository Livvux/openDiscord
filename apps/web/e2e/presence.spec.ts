import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, signUp } from "./helpers";

test.describe("presence and notification level", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("online status is opt-in; muting a community is personal", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Otto Online");
    await createCommunity(owner, "Lounge");
    const invitePath = await createInviteLink(owner);
    const member = await joinAsNewUser(browser, "Pia Present", invitePath);
    const communityUrl = member.url();

    // Not shown before opting in.
    await owner.getByRole("link", { name: "Community settings" }).click();
    await expect(owner.getByText("Pia Present")).toBeVisible();
    await expect(owner.getByText("(online)")).toHaveCount(0);

    await member.goto("/app/settings");
    await member.getByRole("switch", { name: /when I'm online/ }).click();
    await expect(member.getByRole("switch", { name: /when I'm online/ })).toBeChecked();
    await expectNoA11yViolations(member);
    await member.goto(communityUrl);

    await owner.reload();
    await expect(owner.getByRole("listitem").filter({ hasText: "Pia Present" }).getByText("(online)")).toBeVisible();

    // The member mutes the community; only their rail shows it.
    await member.getByRole("link", { name: "Community info" }).click();
    await member.getByRole("radio", { name: /Muted/ }).click();
    await expect(member.getByRole("radio", { name: /Muted/ })).toBeChecked();
    await member.reload();
    await expect(member.getByRole("link", { name: /Lounge.*muted/ })).toBeVisible();
    await expect(owner.getByRole("link", { name: /Lounge.*muted/ })).toHaveCount(0);
  });
});
