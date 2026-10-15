import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, signUp } from "./helpers";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.describe("private community images", () => {
  test.skip(!process.env.R2_ENDPOINT && !process.env.ATTACHMENT_DIR, "needs private attachment storage");
  test("manager library, composer, reactions and deletion fallback on desktop and mobile", async ({ browser, isMobile }, testInfo) => {
    test.setTimeout(120_000);
    const page = await newUserPage(browser);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await signUp(page, "Image Keeper");
    await createCommunity(page, "Image Library");
    const channelUrl = page.url();
    const communityId = /\/c\/([^/]+)/.exec(channelUrl)![1];
    await page.goto(`/app/c/${communityId}/settings`);
    for (const kind of ["emoji", "sticker"]) {
      await page.getByLabel("Image name", { exact: true }).fill(`test_${kind}`);
      await page.getByLabel("Image kind", { exact: true }).selectOption(kind);
      await page.getByLabel("Static image", { exact: true }).setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
      const response = page.waitForResponse((response) => response.url().includes(`/communities/${communityId}/assets?`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "Upload community image" }).click();
      expect((await response).status()).toBe(201);
      await expect(page.getByRole("button", { name: `Delete test_${kind}`, exact: true })).toBeVisible();
    }
    await expectNoA11yViolations(page);
    await page.goto(channelUrl);
    const toggle = page.getByRole("button", { name: "Open navigation", exact: true });
    if (isMobile) {
      await expect(toggle).toBeVisible();
      await toggle.click();
    }
    const invite = await createInviteLink(page);
    await page.keyboard.press("Escape");
    const chat = await joinAsNewUser(browser, "Image Member", invite);
    chat.on("pageerror", (error) => errors.push(error.message));
    chat.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    for (const kind of ["emoji", "sticker"]) {
      await chat.getByRole("button", { name: "Choose community emoji or sticker" }).click();
      await chat.getByRole("button", { name: `Choose ${kind} test_${kind}`, exact: true }).click();
    }
    await chat.getByRole("button", { name: "Send message", exact: true }).click();
    const log = chat.getByRole("log");
    await expect(log.getByRole("img", { name: ":test_emoji:", exact: true })).toBeVisible();
    await expect(log.getByRole("img", { name: "[sticker: test_sticker]", exact: true })).toBeVisible();
    const row = log.getByRole("listitem").filter({ has: chat.getByRole("img", { name: "[sticker: test_sticker]", exact: true }) }).first();
    await row.hover();
    const reactButton = row.getByRole("button", { name: "Add reaction" });
    const geometry = await reactButton.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const log = button.closest('[role="log"]')!.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, logTop: log.top, logBottom: log.bottom, width: innerWidth };
    });
    expect(geometry.top).toBeGreaterThanOrEqual(Math.max(0, geometry.logTop));
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.logBottom);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width);
    await reactButton.click();
    await row.getByRole("button", { name: "Choose emoji test_emoji", exact: true }).click();
    await expect(row.getByRole("button", { name: /:test_emoji: 1 reaction/ })).toBeVisible();
    await expectNoA11yViolations(chat);
    expect(await chat.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await chat.screenshot({ path: testInfo.outputPath("community-assets.png"), fullPage: true });
    const imageUrl = await log.getByRole("img", { name: ":test_emoji:", exact: true }).first().getAttribute("src");
    expect((await chat.request.get(imageUrl!)).headers()["cache-control"]).toBe("private, no-store");
    await page.goto(`/app/c/${communityId}/settings`);
    const archiveLink = page.getByRole("link", { name: "Download archive with files", exact: true });
    const archiveResponse = await page.request.get((await archiveLink.getAttribute("href"))!);
    expect(archiveResponse.status()).toBe(200);
    const importedResponse = await page.request.post("/api/communities/import", { data: await archiveResponse.body(), headers: { "Content-Type": "application/gzip", Origin: new URL(page.url()).origin } });
    expect(importedResponse.status()).toBe(201);
    const imported = await importedResponse.json() as { communityId: string };
    await page.goto(`/app/c/${imported.communityId}`);
    await expect(page.getByRole("log").getByRole("img", { name: ":test_emoji:", exact: true })).toBeVisible();
    expect(await page.getByRole("log").getByRole("img", { name: ":test_emoji:", exact: true }).getAttribute("src")).not.toBe(imageUrl);
    await page.goto(`/app/c/${communityId}/settings`);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete test_emoji", exact: true }).click();
    await expect(page.getByRole("button", { name: "Delete test_emoji", exact: true })).toHaveCount(0);
    await chat.goto(channelUrl);
    await expect(chat.getByRole("log").getByRole("img", { name: ":test_emoji:", exact: true })).toHaveCount(0);
    await expect(chat.getByRole("log").getByText(":test_emoji:", { exact: true }).first()).toBeVisible();
    expect((await page.request.get(imageUrl!)).status()).toBe(404);
    expect(errors).toEqual([]);
    await chat.context().close();
    await page.context().close();
  });
});
