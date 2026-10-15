import { expect, test } from "@playwright/test";
import { createChannel, createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, signUp } from "./helpers";

test.describe("categories", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("channels grouped in a collapsible category, live for members", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Cara Category");
    await createCommunity(owner, "Organized");
    const invitePath = await createInviteLink(owner);
    const member = await joinAsNewUser(browser, "Dan Dweller", invitePath);

    await owner.getByRole("link", { name: "Community settings" }).click();
    await owner.getByLabel("New category").fill("Projects");
    await owner.getByRole("button", { name: "Create", exact: true }).click();
    await expect(owner.getByLabel("Name of category Projects")).toBeVisible();
    await expectNoA11yViolations(owner);

    await createChannel(owner, "roadmap");
    await owner.getByRole("button", { name: "Channel settings" }).click();
    await owner.getByRole("dialog").getByLabel("Category", { exact: true }).selectOption({ label: "Projects" });
    await owner.getByRole("dialog").getByRole("button", { name: "Save" }).click();

    const group = member.getByRole("button", { name: "Projects" });
    await expect(group).toHaveAttribute("aria-expanded", "true");
    await expect(member.getByRole("link", { name: /roadmap/ })).toBeVisible();
    await group.click();
    await expect(group).toHaveAttribute("aria-expanded", "false");
    await expect(member.getByRole("link", { name: /roadmap/ })).toHaveCount(0);
    await member.reload();
    await expect(member.getByRole("button", { name: "Projects" })).toHaveAttribute("aria-expanded", "false");
  });
});
