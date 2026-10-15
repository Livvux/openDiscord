import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, sendMessage, signUp } from "./helpers";

test.describe("safety controls", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("blocking collapses messages; pausing invites stops joins", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Sam Safe");
    await createCommunity(owner, "Quiet Place");
    const invitePath = await createInviteLink(owner);
    const troll = await joinAsNewUser(browser, "Toby Troll", invitePath);
    await sendMessage(troll, "buy cheap followers");

    const spam = owner.getByRole("log").getByRole("listitem").filter({ hasText: "buy cheap followers" });
    await spam.hover();
    owner.once("dialog", (d) => d.accept());
    await spam.getByRole("button", { name: "Block Toby Troll" }).click();
    await expect(owner.getByText("Message from a blocked person.")).toBeVisible();
    await expect(owner.getByRole("log").getByText("buy cheap followers")).toHaveCount(0);
    await owner.getByRole("button", { name: "Show blocked message" }).click();
    await expect(owner.getByRole("log").getByText("buy cheap followers")).toBeVisible();

    // The blocked person isn't told and still sees the community normally.
    await expect(troll.getByRole("log").getByText("buy cheap followers")).toBeVisible();

    // Pause invites: the link stops working for newcomers.
    await owner.getByRole("link", { name: "Community settings" }).click();
    await owner.getByRole("switch", { name: /Pause invites/ }).click();
    await owner.getByRole("button", { name: "Save safety settings" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(owner.getByText("paused invites")).toBeVisible();
    await expectNoA11yViolations(owner);

    const newcomer = await newUserPage(browser);
    await signUp(newcomer, "Nora New");
    await newcomer.goto(invitePath);
    await expect(newcomer.getByText("This community has paused new members.")).toBeVisible();
    await expect(newcomer.getByRole("button", { name: "Accept invite" })).toHaveCount(0);

    // Unblock from account settings.
    await owner.goto("/app/settings");
    await owner.getByRole("button", { name: "Unblock Toby Troll" }).click();
    await expect(owner.getByText("You haven't blocked anyone.")).toBeVisible();
  });
});
