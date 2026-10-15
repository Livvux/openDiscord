import { expect, test } from "@playwright/test";
import { createCommunity, expectNoA11yViolations, newUserPage, signUp } from "./helpers";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.describe("private community images", () => {
  test.skip(!process.env.R2_ENDPOINT && !process.env.ATTACHMENT_DIR, "needs private attachment storage");
  test("manager library, composer, reactions and deletion fallback on desktop and mobile", async ({ browser }, testInfo) => {
    const page = await newUserPage(browser);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
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
    for (const kind of ["emoji", "sticker"]) {
      await page.getByRole("button", { name: "Choose community emoji or sticker" }).click();
      await page.getByRole("button", { name: `Choose ${kind} test_${kind}`, exact: true }).click();
    }
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const log = page.getByRole("log");
    await expect(log.getByRole("img", { name: ":test_emoji:", exact: true })).toBeVisible();
    await expect(log.getByRole("img", { name: "[sticker: test_sticker]", exact: true })).toBeVisible();
    const row = log.getByRole("listitem").filter({ has: page.getByRole("img", { name: "[sticker: test_sticker]", exact: true }) }).first();
    await row.hover();
    await row.getByRole("button", { name: "Add reaction" }).click();
    await row.getByRole("button", { name: "Choose emoji test_emoji", exact: true }).click();
    await expect(row.getByRole("button", { name: /:test_emoji: 1 reaction/ })).toBeVisible();
    await expectNoA11yViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("community-assets.png"), fullPage: true });
    const imageUrl = await log.getByRole("img", { name: ":test_emoji:", exact: true }).first().getAttribute("src");
    expect((await page.request.get(imageUrl!)).headers()["cache-control"]).toBe("private, no-store");
    await page.goto(`/app/c/${communityId}/settings`);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete test_emoji", exact: true }).click();
    await expect(page.getByRole("button", { name: "Delete test_emoji", exact: true })).toHaveCount(0);
    await page.goto(channelUrl);
    await expect(page.getByRole("log").getByRole("img", { name: ":test_emoji:", exact: true })).toHaveCount(0);
    await expect(page.getByRole("log").getByText(":test_emoji:", { exact: true }).first()).toBeVisible();
    expect((await page.request.get(imageUrl!)).status()).toBe(404);
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
