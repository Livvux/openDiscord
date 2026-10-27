import { expect, test } from "@playwright/test";
import { createCommunity, expectNoA11yViolations, newUserPage, signUp } from "./helpers";

test("an owner lists a community in Discover and a stranger joins it without an invite", async ({ browser, isMobile }, testInfo) => {
  test.skip(isMobile, "the settings flow drives the desktop sidebar");
  const name = `Lathe Club ${Date.now().toString(36)}`;
  const owner = await newUserPage(browser);
  const stranger = await newUserPage(browser);
  const anon = await newUserPage(browser);
  try {
    await signUp(owner, "Olga Owner");
    await createCommunity(owner, name);
    await owner.getByRole("link", { name: "Community settings" }).click();
    await owner.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Overview", exact: true }).click();
    await owner.getByRole("switch", { name: /Show in Discover/ }).click();
    await owner.getByLabel("Description").fill("Turning wood, sharing jigs.");
    await owner.getByRole("button", { name: "Save", exact: true }).last().click();
    await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

    await signUp(stranger, "Sam Stranger");
    await stranger.goto("/discover");
    await expect(stranger).toHaveURL(/\/app\/discover$/);
    await stranger.getByLabel("Explore communities").fill(name);
    await stranger.getByLabel("Explore communities").press("Enter");
    const card = stranger.getByRole("link", { name: new RegExp(name) });
    await expect(card).toContainText("Turning wood, sharing jigs.");
    await expect(card).toContainText("1 Member");
    await expectNoA11yViolations(stranger);
    await stranger.screenshot({ path: testInfo.outputPath("discover.png") });
    await card.click();
    await expect(stranger.getByRole("heading", { level: 1, name })).toBeVisible();
    await stranger.screenshot({ path: testInfo.outputPath("discover-preview.png") });
    await stranger.getByRole("button", { name: "Join community" }).click();
    await expect(stranger.getByRole("heading", { level: 1, name: "general" })).toBeVisible();

    await anon.goto("/discover");
    await expect(anon.getByRole("list", { name: "Public communities" }).getByRole("heading", { name })).toBeVisible();
    await anon.screenshot({ path: testInfo.outputPath("discover-anonymous.png"), fullPage: true });
  } finally {
    await Promise.all([owner.context().close(), stranger.context().close(), anon.context().close()]);
  }
});
