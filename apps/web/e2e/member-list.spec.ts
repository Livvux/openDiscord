import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, signUp } from "./helpers";

test.describe("member list", () => {
  test("lists members by online status and can be toggled", async ({ browser, isMobile }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Mona Owner");
    await createCommunity(owner, "Roster");
    if (isMobile) await owner.getByRole("button", { name: "Open navigation" }).click();
    const member = await joinAsNewUser(browser, "Max Member", await createInviteLink(owner));
    await owner.reload();

    const list = owner.getByRole("complementary", { name: "Members" });
    const toggle = owner.getByRole("button", { name: /member list/ });
    // Docked on desktop, an overlay opened from the header on small screens.
    if (isMobile) {
      await expect(list).toBeHidden();
      await toggle.click();
    }
    await expect(list.getByRole("region", { name: "Offline members" }).getByRole("listitem")).toHaveCount(2);
    await expect(list.getByRole("listitem").filter({ hasText: "Max Member" })).toBeVisible();
    await expect(list.getByRole("listitem").filter({ hasText: "Mona Owner" }).getByLabel("Owner")).toBeVisible();
    await expectNoA11yViolations(owner);

    // Opting in moves the member to the online group on a later load.
    await member.goto("/app/settings");
    await member.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Online status", exact: true }).click();
    await member.getByRole("switch", { name: /when I'm online/ }).click();
    await expect(member.getByRole("switch", { name: /when I'm online/ })).toBeChecked();
    await member.goBack();
    await expect(async () => {
      await owner.reload();
      if (isMobile) await toggle.click();
      await expect(list.getByRole("region", { name: "Online members" }).getByText("Max Member")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    // The overlay's backdrop covers the header, so it closes with Escape there.
    await (isMobile ? owner.keyboard.press("Escape") : toggle.click());
    await expect(list).toBeHidden();
    if (!isMobile) {
      // The choice sticks across reloads.
      await owner.reload();
      await expect(list).toBeHidden();
      await owner.getByRole("button", { name: "Show member list" }).click();
      await expect(list).toBeVisible();
    }
  });
});
