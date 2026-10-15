import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createCommunity, expectNoA11yViolations, newUserPage, signUp } from "./helpers";

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
    await owner.getByLabel("Or import an export file").setInputFiles(file);
    await expect(owner.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
    const msg = owner.getByRole("log").getByRole("listitem").filter({ hasText: "First message" });
    await expect(msg.getByText("IMPORTED")).toBeVisible();
    await expect(msg.locator("strong", { hasText: "First" })).toBeVisible();
    await expect(owner.getByRole("link", { name: "Old Home" })).toHaveCount(2);
  });
});
