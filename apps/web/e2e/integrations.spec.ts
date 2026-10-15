import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, signUp } from "./helpers";

test.describe("bots and webhooks", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("a webhook posts live; a bot uses the public API with its token", async ({ browser, request }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Ivy Integrator");
    await createCommunity(owner, "Automation");
    const invitePath = await createInviteLink(owner);
    const member = await joinAsNewUser(browser, "Jo Joiner", invitePath);

    await owner.getByRole("link", { name: "Community settings" }).click();
    await owner.getByLabel("New webhook").fill("CI");
    await owner.getByRole("button", { name: "Create webhook" }).click();
    const url = await owner.getByLabel(/Webhook URL/).inputValue();
    await expectNoA11yViolations(owner);

    const posted = await request.post(url, { data: { content: "Deploy **finished**" } });
    expect(posted.status()).toBe(201);
    const msg = member.getByRole("log").getByRole("listitem").filter({ hasText: "Deploy finished" });
    await expect(msg.getByText("BOT")).toBeVisible();
    await expect(msg.locator("strong", { hasText: "finished" })).toBeVisible();
    expect((await request.post(url.replace(/[^/]+$/, `od_wh_${"x".repeat(43)}`), { data: { content: "forged" } })).status()).toBe(404);

    await owner.getByLabel("New bot").fill("Helper");
    await owner.getByRole("button", { name: "Create bot" }).click();
    const token = await owner.getByLabel(/Bot token/).inputValue();
    const me = await request.get("/api/v1/me", { headers: { Authorization: `Bot ${token}` } });
    expect(await me.json()).toMatchObject({ name: "Helper" });
    expect((await request.get("/api/v1/me")).status()).toBe(401);
    expect((await request.get("/api/v1/openapi.json")).ok()).toBe(true);
  });
});
