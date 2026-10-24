import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, signUp } from "./helpers";

test("friend requests and private messages reach Home live, with unread badges cleared on reading", async ({ browser, isMobile }) => {
  test.skip(isMobile, "the invite helper drives the desktop sidebar");
  test.setTimeout(120_000);
  const owner = await newUserPage(browser);
  await signUp(owner, "Uma Unread");
  await createCommunity(owner, "Unread Lab");
  const friend = await joinAsNewUser(browser, "Rex Reader", await createInviteLink(owner));

  try {
    // The recipient stays on Home; nothing below reloads it.
    await friend.goto("/app");
    const home = friend.getByRole("navigation", { name: "Home" });
    await owner.goto("/app");
    await owner.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: "Add Friend" }).click();
    await owner.getByLabel("Search your communities").fill("Rex");
    await owner.getByRole("button", { name: "Search" }).click();
    await owner.getByRole("button", { name: "Add friend: Rex Reader" }).click();
    await expect(home.getByRole("link", { name: "Friends, 1 pending" })).toBeVisible({ timeout: 10_000 });
    await friend.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: /^Pending/ }).click();
    await friend.getByRole("button", { name: "Accept friend request from Uma Unread" }).click();

    await owner.goto("/app");
    await owner.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: /^All/ }).click();
    await owner.getByRole("main").getByRole("link", { name: "Message Rex Reader" }).click();
    await expect(owner.getByRole("log", { name: "Private conversation with Rex Reader" })).toBeVisible({ timeout: 30_000 });
    const composer = owner.getByLabel("Encrypted message");
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await composer.fill("Did you see this?");
    await composer.press("Enter");
    await expect(owner.getByRole("log").getByText("Did you see this?")).toBeVisible({ timeout: 30_000 });

    const conversation = home.getByRole("link", { name: "Uma Unread, 1 unread message" });
    await expect(conversation).toBeVisible({ timeout: 10_000 });
    await expect(friend.getByRole("link", { name: "Home, 1 unread private message" })).toBeVisible();

    await conversation.click();
    await expect(friend.getByRole("log", { name: "Private conversation with Uma Unread" }).getByText("Did you see this?")).toBeVisible({ timeout: 30_000 });
    await expect(friend.locator("[data-home-unread]")).toHaveCount(0, { timeout: 10_000 });
    await expect(friend.locator("[data-dm-unread]")).toHaveCount(0);

    // The marker is stored: a fresh load of Home shows nothing unread.
    await friend.goto("/app");
    await expect(home.locator("[data-dm-peer-name]", { hasText: "Uma Unread" })).toBeVisible();
    await expect(friend.locator("[data-dm-unread]")).toHaveCount(0);
    await expect(friend.locator("[data-home-unread]")).toHaveCount(0);
  } finally {
    await Promise.all([owner.context().close(), friend.context().close()]);
  }
});
