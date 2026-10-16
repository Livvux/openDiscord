import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createCommunity, expectNoA11yViolations, newUserPage, signUp } from "./helpers";
import { withCommunityImport } from "./import-lock";

test.describe("community export and import", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("the owner exports a community and imports it as a new one", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Erin Export");
    await createCommunity(owner, "Old Home");
    const composer = owner.getByRole("textbox", { name: "Message #general" });
    await composer.fill("**First** message");
    await composer.press("Enter");
    await expect(owner.getByRole("log").locator("strong", { hasText: "First" })).toBeVisible();

    await owner.getByRole("link", { name: "Community settings" }).click();
    const downloadEvent = owner.waitForEvent("download");
    await owner.getByRole("link", { name: "Download community export" }).click();
    const file = await (await downloadEvent).path();
    const data = JSON.parse(await readFile(file, "utf8")) as { format: string; messages: unknown[] };
    expect(data.format).toBe("opendiscord.community-export");
    expect(data.messages).toHaveLength(1);

    await owner.getByRole("button", { name: "Create a community" }).first().click();
    await expectNoA11yViolations(owner);
    await withCommunityImport(async () => {
      const importing = owner.waitForResponse((response) => response.url().endsWith("/api/communities/import") && response.request().method() === "POST");
      await owner.getByLabel("Or import an export file").setInputFiles(file);
      const response = await importing;
      expect(response.status()).toBe(201);
      await response.body();
    });
    await expect(owner.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
    const msg = owner.getByRole("log").getByRole("listitem").filter({ hasText: "First message" });
    await expect(msg.getByText("IMPORTED")).toBeVisible();
    await expect(msg.locator("strong", { hasText: "First" })).toBeVisible();
    await expect(owner.getByRole("link", { name: "Old Home" })).toHaveCount(2);
  });
});

// Complete archive acceptance runs on both desktop and mobile with real private filesystem storage.
test("the owner migrates a complete archive with private image and binary files", async ({ browser }, info) => {
  test.skip(!process.env.R2_ENDPOINT && !process.env.ATTACHMENT_DIR, "needs private attachment storage");
  test.setTimeout(90_000);
  const owner = await newUserPage(browser);
  owner.context().setDefaultTimeout(15_000);
  owner.context().setDefaultNavigationTimeout(30_000);
  const errors: string[] = [];
  owner.on("pageerror", (error) => errors.push(error.message));
  const binary = Buffer.from("<script>window.archiveMustNotExecute=true</script>");
  const toggle = owner.getByRole("button", { name: "Open navigation", exact: true });
  async function closeNavigation() {
    if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") === "true") {
      await owner.keyboard.press("Escape");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    }
  }
  try {
    await signUp(owner, "Portable Pat");
    await createCommunity(owner, "Archive Home");
    await closeNavigation();
    const chooser = owner.waitForEvent("filechooser");
    await owner.getByRole("button", { name: /Attach files/ }).click();
    await (await chooser).setFiles([
      { name: "notes.html", mimeType: "text/html", buffer: binary },
      { name: "dot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") },
    ]);
    await expect(owner.getByRole("list", { name: "Attachments" }).getByRole("status")).toHaveCount(0);
    await owner.getByRole("textbox", { name: "Message #general" }).fill("Portable archive");
    await owner.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(owner.getByRole("log").getByText("Portable archive", { exact: true })).toBeVisible();
    const settings = owner.getByRole("link", { name: "Community settings", exact: true });
    await expect.poll(async () => await settings.isVisible() || await toggle.isVisible()).toBe(true);
    if (!await settings.isVisible()) await toggle.click();
    await settings.click();
    await closeNavigation();
    await expect(owner).toHaveTitle("Community settings · openDiscord");
    await expectNoA11yViolations(owner);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const downloadEvent = owner.waitForEvent("download");
    await owner.getByRole("link", { name: "Download archive with files", exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/\.odc\.gz$/);
    const path = await download.path();
    if (!path) throw new Error("Archive download missing");
    const archive = await readFile(path);
    expect([...archive.subarray(0, 2)]).toEqual([31, 139]);
    const create = owner.getByRole("button", { name: "Create a community", exact: true }).first();
    if (!await create.isVisible()) await toggle.click();
    await create.click();
    const imported = await withCommunityImport(async () => {
      const importing = owner.waitForResponse((response) => response.url().endsWith("/api/communities/import") && response.request().method() === "POST");
      await owner.getByRole("dialog", { name: "Create a community", exact: true }).getByLabel("Or import an export file").setInputFiles({ name: "community.odc.gz", mimeType: "application/gzip", buffer: archive });
      const importedResponse = await importing;
      expect(importedResponse.status()).toBe(201);
      return await importedResponse.json() as { communityId: string };
    });
    await expect(owner).toHaveURL(new RegExp(`/app/c/${imported.communityId}/`));
    await expect(owner.getByRole("dialog", { name: "Create a community", exact: true })).toBeHidden();
    await expect(owner.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
    await closeNavigation();
    const message = owner.getByRole("log").getByRole("listitem").filter({ hasText: "Portable archive" });
    await expect(message.getByText("IMPORTED", { exact: true })).toBeVisible();
    await expect(message.getByRole("img", { name: "Image 1 from Portable Pat" })).toBeVisible();
    const fileEvent = owner.waitForEvent("download");
    await message.getByRole("link", { name: /notes\.html/ }).click();
    const file = await fileEvent;
    const filePath = await file.path();
    if (!filePath) throw new Error("Imported file download missing");
    expect(await readFile(filePath)).toEqual(binary);
    expect(await owner.evaluate(() => "archiveMustNotExecute" in window)).toBe(false);
    await expectNoA11yViolations(owner);
    await expect(owner.getByRole("button", { name: "Send message", exact: true })).toBeInViewport({ ratio: 1 });
    expect(await message.locator("time").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(32);
    await owner.screenshot({ path: info.outputPath("complete-community-archive.png"), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await owner.context().close(); }
});
