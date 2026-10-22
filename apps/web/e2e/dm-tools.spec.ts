import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, signUp } from "./helpers";

test("encrypted DM replies, edits, reactions, local search, typing and deletion survive reload", async ({ browser }, info) => {
  test.setTimeout(240_000);
  const alice = await newUserPage(browser);
  await alice.setViewportSize({ width: 1280, height: 900 });
  await signUp(alice, "Tools Alice");
  await createCommunity(alice, "Tools Lab");
  const bob = await joinAsNewUser(browser, "Tools Bob", await createInviteLink(alice));
  await bob.setViewportSize({ width: 1280, height: 900 });
  const errors: string[] = [], wire: string[] = [];
  for (const page of [alice, bob]) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/dm")) wire.push(request.url() + (request.postData() ?? "")); });
  }
  try {
    const aliceId = (await alice.request.get("/api/auth/get-session").then((r) => r.json())).user.id as string;
    const bobId = (await bob.request.get("/api/auth/get-session").then((r) => r.json())).user.id as string;
    // The normal request/accept flow, without friendship or a privileged encryption override.
    await bob.goto("/app/messages");
    await expect(bob.getByText("Encrypted messaging ready.")).toBeVisible({ timeout: 30_000 });
    await alice.goto(`/app/messages?to=${bobId}`);
    await alice.getByRole("button", { name: "Send message request", exact: true }).click();
    const conversationId = (await alice.request.get("/api/dm").then((r) => r.json())).conversations[0].id as string;
    await bob.goto(`/app/messages?c=${conversationId}`);
    await bob.getByRole("button", { name: "Accept message request", exact: true }).click();
    const aLog = alice.getByRole("log"), bLog = bob.getByRole("log");
    const composer = alice.getByLabel("Encrypted message", { exact: true });
    const original = "Original encrypted tools message 87342";
    await composer.fill(original);
    await expect(bob.getByText("Tools Alice is typing…", { exact: true })).toBeVisible({ timeout: 10_000 });
    await composer.press("Enter");
    await expect(bLog.getByText(original, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(bob.getByText("Tools Alice is typing…", { exact: true })).toHaveCount(0, { timeout: 10_000 });

    const firstA = aLog.locator("li").filter({ has: alice.getByText(original, { exact: true }) });
    const firstB = bLog.locator("li").filter({ has: bob.getByText(original, { exact: true }) });
    await expect(firstB.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await firstB.getByRole("button", { name: "Reply", exact: true }).click();
    await bob.getByLabel("Encrypted message", { exact: true }).fill("Private reply 91823");
    await bob.getByRole("button", { name: "Send encrypted message", exact: true }).click();
    await expect(aLog.getByRole("link", { name: `Reply: ${original}` })).toBeVisible({ timeout: 30_000 });
    await firstB.locator("summary").click();
    await firstB.getByRole("button", { name: "React 👍", exact: true }).click();
    await expect(firstA.getByRole("button", { name: "👍: 1 reactions", exact: true })).toBeVisible({ timeout: 30_000 });

    await firstA.getByRole("button", { name: "Edit", exact: true }).click();
    await firstA.getByLabel("Edit encrypted message").fill("Corrected encrypted tools message 87342");
    await firstA.getByRole("button", { name: "Save edit", exact: true }).click();
    await expect(bLog.getByText("Corrected encrypted tools message 87342", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(bLog.getByRole("link", { name: "Reply: Corrected encrypted tools message 87342" })).toBeVisible();
    await bob.getByRole("button", { name: "Search this conversation", exact: true }).click();
    await bob.getByLabel("Search private messages").fill("Corrected encrypted");
    await expect(bLog.getByText("Corrected encrypted tools message 87342", { exact: true })).toBeVisible();
    await expect(bLog.getByText("Private reply 91823", { exact: true })).toHaveCount(0);
    await bob.getByRole("button", { name: "Search this conversation", exact: true }).click();

    alice.once("dialog", (dialog) => dialog.accept());
    await aLog.locator("li").filter({ has: alice.getByText("Corrected encrypted tools message 87342", { exact: true }) }).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(bLog.getByText("Message deleted", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(bLog.getByText("Corrected encrypted tools message 87342", { exact: true })).toHaveCount(0);
    await bob.reload();
    await expect(bob.getByRole("log").getByText("Message deleted", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(bob.getByRole("log").getByRole("link", { name: "Reply: Deleted message" })).toBeVisible();
    const timeline = await bob.request.get(`/api/dm?conversation=${conversationId}`).then((r) => r.json());
    expect(timeline.messages.find((m: { kind: string }) => m.kind === "message").content).toEqual({});
    expect(wire.join("\n")).not.toContain(original);
    expect(wire.join("\n")).not.toContain("Corrected encrypted");
    expect(wire.join("\n")).not.toContain("Private reply 91823");
    expect(aliceId).not.toBe(bobId);
    await bob.setViewportSize({ width: 390, height: 844 });
    expect(await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await bob.screenshot({ path: info.outputPath("dm-tools-mobile.png") });
    expect(errors).toEqual([]);
  } finally { await Promise.all([alice.context().close(), bob.context().close()]); }
});
