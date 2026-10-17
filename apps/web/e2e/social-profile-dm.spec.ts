import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, sendMessage, signUp } from "./helpers";

// Discord flow end to end: click a name for the profile, add a friend there, accept on Home,
// open the DM from the friends list, write, and the friend sees it live and answers.
test("profile card, friends Home and a live encrypted DM between two friends", async ({ browser, isMobile }, info) => {
  test.skip(isMobile, "desktop layout: member list, Active Now and the DM profile panel");
  test.setTimeout(180_000);
  const alice = await newUserPage(browser);
  const errors: string[] = [];
  alice.on("pageerror", (e) => errors.push(e.message));
  await signUp(alice, "Social Alice");
  await createCommunity(alice, "Social Club");
  const invite = await createInviteLink(alice);
  const bob = await joinAsNewUser(browser, "Social Bob", invite);
  bob.on("pageerror", (e) => errors.push(e.message));
  await sendMessage(bob, "Hello from Bob");

  // Left click on the author name opens the profile card; right click keeps the user menu.
  const author = alice.getByRole("log", { name: /Messages in/ }).getByRole("button", { name: "View profile of Social Bob", exact: true }).last();
  await author.click();
  const card = alice.getByRole("dialog", { name: "Social Bob" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Member since")).toBeVisible();
  await expect(card.getByRole("link", { name: "Social Club" })).toBeVisible();
  await expect(card.getByRole("link", { name: "Message" })).toBeVisible();
  await expectNoA11yViolations(alice);
  await alice.screenshot({ path: info.outputPath("profile-popover.png") });
  await card.getByRole("button", { name: "Add Friend" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Friend request sent." })).toBeVisible();
  await alice.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await author.click({ button: "right" });
  await expect(alice.getByRole("menu", { name: "User actions" })).toBeVisible();
  await alice.keyboard.press("Escape");

  // Bob accepts on Home, which is the friends list.
  await bob.goto("/app");
  await expect(bob.getByRole("heading", { level: 1, name: "Friends" })).toBeVisible();
  await bob.getByRole("button", { name: "Accept friend request from Social Alice" }).click();
  await bob.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: /^All/ }).click();
  await expect(bob.getByRole("region", { name: "Your friends" }).getByRole("button", { name: /Social Alice/ })).toBeVisible();

  // Alice opens the DM from Home; friends need no message request and no prior device verification.
  await alice.goto("/app");
  await alice.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: /^All/ }).click();
  await expectNoA11yViolations(alice);
  await alice.screenshot({ path: info.outputPath("home-friends.png") });
  await alice.getByRole("link", { name: "Message Social Bob" }).click();
  await expect(alice).toHaveURL(/\/app\/messages\?to=/);
  await expect(alice.getByRole("heading", { level: 1, name: "Social Bob" })).toBeVisible({ timeout: 30_000 });
  await expect(alice.getByRole("complementary", { name: "Profile" }).getByText("Member since")).toBeVisible();
  const first = "Hi Bob, this is end-to-end encrypted 4711";
  const composer = alice.getByLabel("Encrypted message", { exact: true });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill(first);
  await composer.press("Enter");
  await expect(alice.getByRole("log", { name: "Private conversation with Social Bob" }).getByText(first, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(composer).toHaveValue("");

  // Bob finds the conversation in the Home sidebar and sees the message, then answers.
  await bob.goto("/app");
  const dm = bob.getByRole("navigation", { name: "Home" }).getByRole("link").filter({ has: bob.locator("[data-dm-peer-name]", { hasText: "Social Alice" }) });
  await dm.click();
  const bobLog = bob.getByRole("log", { name: "Private conversation with Social Alice" });
  await expect(bobLog.getByText(first, { exact: true })).toBeVisible({ timeout: 30_000 });
  const reply = "Got it, Alice 0815";
  await bob.getByLabel("Encrypted message", { exact: true }).fill(reply);
  await bob.getByRole("button", { name: "Send encrypted message", exact: true }).click();

  // Alice sees the reply live without reloading.
  await expect(alice.getByRole("log", { name: "Private conversation with Social Bob" }).getByText(reply, { exact: true })).toBeVisible({ timeout: 30_000 });
  const conversationId = (await alice.request.get("/api/dm").then((r) => r.json())).conversations[0].id as string;
  expect(await alice.request.get(`/api/dm?conversation=${conversationId}`).then((r) => r.text())).not.toContain(first);
  await expectNoA11yViolations(alice);
  await alice.screenshot({ path: info.outputPath("dm-conversation.png") });
  await bob.screenshot({ path: info.outputPath("dm-conversation-bob.png") });
  expect(errors).toEqual([]);
  await Promise.all([alice.context().close(), bob.context().close()]);
});
