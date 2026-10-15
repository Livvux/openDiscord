import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, sendMessage, signUp } from "./helpers";

test.describe("threads", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("a thread keeps a side conversation out of the channel, live for everyone", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Theo Thread");
    await createCommunity(owner, "Forum");
    const invitePath = await createInviteLink(owner);
    const member = await joinAsNewUser(browser, "Uli User", invitePath);

    await sendMessage(owner, "Who wants to plan the meetup?");
    const root = member.getByRole("log").getByRole("listitem").filter({ hasText: "Who wants to plan the meetup?" });
    await root.hover();
    await root.getByRole("button", { name: "Start a thread" }).click();
    const panel = member.getByRole("complementary", { name: "Thread by Theo Thread" });
    await expect(panel.getByText("Who wants to plan the meetup?")).toBeVisible();
    const composer = panel.getByRole("textbox", { name: "Reply in thread" });
    await composer.fill("Me! Saturday works");
    await composer.press("Enter");
    await expect(panel.getByRole("log", { name: "Thread replies" }).getByText("Me! Saturday works")).toBeVisible();
    await expectNoA11yViolations(member);

    // The channel shows a summary, not the reply.
    const ownerRoot = owner.getByRole("log").getByRole("listitem").filter({ hasText: "Who wants to plan the meetup?" });
    await expect(ownerRoot.getByRole("button", { name: /1 reply/ })).toBeVisible();
    await expect(owner.getByRole("log", { name: /Messages in/ }).getByText("Me! Saturday works")).toHaveCount(0);
    await ownerRoot.getByRole("button", { name: /1 reply/ }).click();
    await expect(owner.getByRole("complementary").getByText("Me! Saturday works")).toBeVisible();
    await owner.keyboard.press("Escape");
    await expect(owner.getByRole("complementary")).toHaveCount(0);
  });
});
