import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, newUserPage, signUp } from "./helpers";

test("a newcomer without friends gets a way in and can paste a full invite link", async ({ browser, isMobile }) => {
  test.skip(isMobile, "the invite helper drives the desktop sidebar");
  const owner = await newUserPage(browser);
  await signUp(owner, "Gina Guide");
  await createCommunity(owner, "Welcome Hall");
  const invitePath = await createInviteLink(owner);
  const newcomer = await newUserPage(browser);

  try {
    await signUp(newcomer, "Nico Newcomer");
    await newcomer.goto("/app");
    const start = newcomer.getByRole("region", { name: "Get started" });
    await expect(start).toBeVisible();
    await expect(start.getByRole("button", { name: "Create a community" })).toBeVisible();
    await expectNoA11yViolations(newcomer);

    await start.getByLabel("Have an invite?").fill("not a link/../admin");
    await start.getByRole("button", { name: "Join" }).click();
    await expect(start.getByRole("alert")).toBeVisible();
    await expect(newcomer).toHaveURL(/\/app$/);

    await start.getByLabel("Have an invite?").fill(new URL(invitePath, newcomer.url()).href);
    await start.getByRole("button", { name: "Join" }).click();
    await newcomer.getByRole("button", { name: "Accept invite" }).click();
    await expect(newcomer.getByRole("heading", { level: 1 })).toBeVisible();
  } finally {
    await Promise.all([owner.context().close(), newcomer.context().close()]);
  }
});
