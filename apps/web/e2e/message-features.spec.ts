import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, sendMessage, signUp } from "./helpers";

test.describe("replies, reactions, pins and markdown", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("a conversation uses replies, reactions, pins and safe formatting", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Mia Mod");
    await createCommunity(owner, "Workshop");
    const invitePath = await createInviteLink(owner);
    const member = await joinAsNewUser(browser, "Leo Learner", invitePath);

    // Markdown renders as formatting; HTML stays text.
    await owner.getByRole("textbox", { name: "Message #general" }).fill("**Rules** read https://example.com/rules <b>x</b>");
    await owner.getByRole("textbox", { name: "Message #general" }).press("Enter");
    const rules = member.getByRole("log").getByRole("listitem").filter({ hasText: "Rules" }).first();
    await expect(rules.locator("strong", { hasText: "Rules" })).toBeVisible();
    await expect(rules.getByRole("link", { name: "https://example.com/rules" })).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    await expect(rules.getByText("<b>x</b>")).toBeVisible();

    // The member replies via the toolbar.
    await rules.hover();
    await rules.getByRole("button", { name: "Reply" }).click();
    await expect(member.getByText("Replying to Mia Mod")).toBeVisible();
    await sendMessage(member, "got it");
    const reply = owner.getByRole("log").getByRole("listitem").filter({ hasText: "got it" });
    await expect(reply.getByRole("button", { name: /Reply to Mia Mod/ })).toBeVisible();

    // Reactions sync live and toggle.
    await rules.hover();
    await rules.getByRole("button", { name: "Add reaction" }).click();
    await member.getByRole("button", { name: "React with 🎉" }).click();
    const ownerRules = owner.getByRole("log").getByRole("listitem").filter({ hasText: "Rules" }).first();
    await expect(ownerRules.getByRole("button", { name: "🎉 1 reaction" })).toBeVisible();
    await ownerRules.getByRole("button", { name: "🎉 1 reaction" }).click();
    await expect(member.getByRole("button", { name: "🎉 2 reactions, including you" })).toBeVisible();

    // The owner pins; the member sees it in the pinned list. Members can't pin.
    await ownerRules.hover();
    await ownerRules.getByRole("button", { name: "Pin message" }).click();
    await expect(rules.getByText("Pinned")).toBeVisible();
    await expect(rules.getByRole("button", { name: /Pin message/ })).toHaveCount(0);
    await member.getByRole("button", { name: "Pinned messages" }).click();
    await expect(member.getByRole("dialog").getByText("Rules", { exact: true })).toBeVisible();
    await expectNoA11yViolations(member);
  });
});
