import { expect, test, type Page } from "@playwright/test";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, signUp } from "./helpers";

async function befriend(owner: Page, friend: Page, friendName: string, ownerName: string) {
  await owner.goto("/app");
  await owner.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: "Add Friend" }).click();
  await owner.getByLabel("Search your communities").fill(friendName);
  await owner.getByRole("button", { name: "Search" }).click();
  await owner.getByRole("button", { name: `Add ${friendName} as a friend` }).click();
  await friend.goto("/app");
  await friend.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: /^Pending/ }).click();
  await friend.getByRole("button", { name: `Accept friend request from ${ownerName}` }).click();
}
async function openGroup(page: Page, name: string) {
  await page.goto("/app/messages");
  const link = page.getByRole("navigation", { name: "Home" }).getByRole("link").filter({ has: page.locator("[data-dm-peer-name]", { hasText: name }) });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}
type Envelope = { id: string; content: { session_id: string } };

test("encrypted group: create from friends, members read, removal is immediate and rotates the Megolm session", async ({ browser, isMobile }) => {
  test.skip(isMobile, "the invite helper drives the desktop sidebar");
  test.setTimeout(240_000);
  const gina = await newUserPage(browser);
  await signUp(gina, "Gina Group");
  await createCommunity(gina, "Group Lab");
  const invite = await createInviteLink(gina);
  const hugo = await joinAsNewUser(browser, "Hugo Group", invite);
  const ivy = await joinAsNewUser(browser, "Ivy Group", invite);
  const wire: string[] = [];
  gina.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/dm") && request.method() === "POST") wire.push(request.postData() ?? ""); });
  try {
    await befriend(gina, hugo, "Hugo Group", "Gina Group");
    await befriend(gina, ivy, "Ivy Group", "Gina Group");
    // Each browser sets up its encryption device on its first visit.
    for (const page of [hugo, ivy]) {
      await page.goto("/app/messages");
      await expect(page.getByText("Encrypted messaging ready.")).toBeVisible({ timeout: 30_000 });
    }

    await gina.goto("/app/messages");
    await gina.getByRole("button", { name: "New group" }).click();
    const form = gina.getByRole("form", { name: "New group" });
    await form.getByLabel("Group name (optional)").fill("Trip crew");
    await form.getByLabel("Hugo Group").check();
    await form.getByLabel("Ivy Group").check();
    await form.getByRole("button", { name: "Create group" }).click();
    await expect(gina.getByRole("heading", { level: 1, name: "Trip crew" })).toBeVisible({ timeout: 20_000 });
    const composer = gina.getByLabel("Encrypted message");
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    const first = "Group secret before removal 5521";
    await composer.fill(first);
    await composer.press("Enter");
    await expect(gina.getByRole("log", { name: "Group conversation Trip crew" }).getByText(first)).toBeVisible({ timeout: 30_000 });

    for (const page of [hugo, ivy]) {
      await openGroup(page, "Trip crew");
      await expect(page.getByRole("log", { name: "Group conversation Trip crew" }).getByText(first)).toBeVisible({ timeout: 30_000 });
    }
    const groupId = (await gina.request.get("/api/dm").then((r) => r.json())).conversations.find((c: { name: string | null }) => c.name === "Trip crew").id as string;
    const before = (await gina.request.get(`/api/dm?conversation=${groupId}`).then((r) => r.json())).messages as Envelope[];
    expect(JSON.stringify(before)).not.toContain(first);
    expect(wire.join("\n")).not.toContain(first);

    // The owner removes Ivy: her access ends now, and the next message uses a new outbound session.
    await gina.getByRole("button", { name: "Group settings" }).click();
    await gina.getByRole("button", { name: "Remove Ivy Group" }).click();
    await expect(gina.getByRole("button", { name: "Remove Ivy Group" })).toHaveCount(0, { timeout: 10_000 });
    expect((await ivy.request.get(`/api/dm?conversation=${groupId}`)).status()).toBe(404);
    const second = "Only Gina and Hugo after removal 7781";
    await composer.fill(second);
    await composer.press("Enter");
    await expect(hugo.getByRole("log", { name: "Group conversation Trip crew" }).getByText(second)).toBeVisible({ timeout: 30_000 });
    const after = (await gina.request.get(`/api/dm?conversation=${groupId}`).then((r) => r.json())).messages as Envelope[];
    expect(after.at(-1)!.content.session_id).not.toBe(before.at(-1)!.content.session_id);
    await ivy.goto("/app/messages");
    await expect(ivy.getByRole("navigation", { name: "Home" }).locator("[data-dm-peer-name]", { hasText: "Trip crew" })).toHaveCount(0, { timeout: 20_000 });

    // Leaving works the same for any member.
    await hugo.getByRole("button", { name: "Group settings" }).click();
    hugo.once("dialog", (dialog) => dialog.accept());
    await hugo.getByRole("button", { name: "Leave group" }).click();
    await expect(hugo.getByRole("navigation", { name: "Home" }).locator("[data-dm-peer-name]", { hasText: "Trip crew" })).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await Promise.all([gina.context().close(), hugo.context().close(), ivy.context().close()]);
  }
});
