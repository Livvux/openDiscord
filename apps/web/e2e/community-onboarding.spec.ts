import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, signUp } from "./helpers";

test.describe("community onboarding", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("new members pick a role offered by the owner, and can choose again", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Olga Onboard");
    await createCommunity(owner, "Interests");
    const invitePath = await createInviteLink(owner);

    await owner.getByRole("link", { name: "Community settings" }).click();
    const nav = owner.getByRole("navigation", { name: "Settings categories" });
    await nav.getByRole("button", { name: "Roles", exact: true }).click();
    await owner.locator("#new-role-name").fill("gamers");
    await owner.getByRole("button", { name: "Create role" }).click();
    await expect(owner.getByLabel("Name", { exact: true }).first()).toBeVisible();
    await nav.getByRole("button", { name: "Onboarding", exact: true }).click();
    await owner.getByRole("checkbox", { name: "gamers" }).check();
    await owner.getByLabel("Label for gamers").fill("Games");
    await owner.getByRole("button", { name: "Save onboarding" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expectNoA11yViolations(owner);

    const member = await joinAsNewUser(browser, "Max Member", invitePath);
    const picker = member.getByRole("region", { name: "What brings you to Interests?" });
    await expect(picker).toBeVisible();
    await expectNoA11yViolations(member);
    await picker.getByRole("checkbox", { name: "Games" }).check();
    await picker.getByRole("button", { name: "Save" }).click();
    await expect(picker).toHaveCount(0);
    await member.reload();
    await expect(member.getByRole("region", { name: "What brings you to Interests?" })).toHaveCount(0);

    // Members reach community settings from the server's context menu; open it directly here.
    await member.goto(`${new URL(member.url()).pathname.split("/").slice(0, 4).join("/")}/settings`);
    await member.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Your roles", exact: true }).click();
    await member.getByRole("button", { name: "Choose again" }).click();
    await expect(member.getByRole("region", { name: "What brings you to Interests?" }).getByRole("checkbox", { name: "Games" })).toBeChecked();
  });
});
