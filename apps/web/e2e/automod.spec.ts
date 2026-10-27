import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, signUp } from "./helpers";

test.describe("AutoMod", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("a blocked word is refused with an explanation and the draft is kept", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Ada Automod");
    await createCommunity(owner, "Clean Chat");
    const invitePath = await createInviteLink(owner);
    await owner.getByRole("link", { name: "Community settings" }).click();
    await owner.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "AutoMod", exact: true }).click();
    await owner.getByLabel("Blocked words").fill("crypto giveaway");
    await owner.getByRole("button", { name: "Save AutoMod rules" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expectNoA11yViolations(owner);

    const member = await joinAsNewUser(browser, "Max Member", invitePath);
    const composer = member.getByRole("textbox", { name: "Message #general" });
    await composer.fill("join my crypto giveaway");
    await composer.press("Enter");
    await expect(member.getByRole("alert").filter({ hasText: "blocked word" })).toBeVisible();
    await expect(composer).toHaveValue("join my crypto giveaway");
    await expect(member.getByRole("log").getByText("join my crypto giveaway")).toHaveCount(0);

    await owner.reload();
    // Role queries skip React's hidden streaming container (<div hidden id="S:n">), which can briefly
    // hold a second copy of the server-rendered section; exactly one entry was audited.
    await owner.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Audit log", exact: true }).click();
    const audit = owner.getByRole("region", { name: "Audit log" });
    await expect(audit.getByRole("listitem").filter({ hasText: "had a message blocked by AutoMod" })).toHaveCount(1);
  });
});
