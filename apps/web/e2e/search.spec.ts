import { expect, test } from "@playwright/test";
import { createChannel, createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, sendMessage, signUp } from "./helpers";

test.describe("search", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("finds messages by word prefix in readable channels only", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Sid Search");
    await createCommunity(owner, "Archive");
    const invitePath = await createInviteLink(owner);
    await sendMessage(owner, "The picnic moves to Saturday");
    await createChannel(owner, "mods");
    await owner.getByRole("button", { name: "Channel settings" }).click();
    await owner.getByRole("dialog").getByLabel("View for everyone").selectOption("deny");
    await expect(owner.getByRole("dialog").getByText(/^Private:/)).toBeVisible();
    await owner.keyboard.press("Escape");
    await sendMessage(owner, "picnic budget stays between us");

    const member = await joinAsNewUser(browser, "Mona Member", invitePath);
    await member.keyboard.press("ControlOrMeta+k");
    const dialog = member.getByRole("dialog", { name: "Search Archive" });
    await dialog.getByRole("searchbox", { name: "Search messages" }).fill("picn satur");
    await expect(dialog.getByRole("status")).toHaveText("1 result, newest first.");
    await expect(dialog.getByText("The picnic moves to Saturday")).toBeVisible();
    await dialog.getByRole("searchbox", { name: "Search messages" }).fill("budget");
    await expect(dialog.getByRole("status")).toHaveText("No messages found.");
    await expectNoA11yViolations(member);
    await dialog.getByRole("searchbox", { name: "Search messages" }).fill("picnic");
    await dialog.getByRole("link", { name: /The picnic moves/ }).click();
    await expect(member.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
  });
});
