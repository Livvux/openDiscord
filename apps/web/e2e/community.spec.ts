import { expect, test } from "@playwright/test";
import {
  createCommunity,
  createChannel,
  createInviteLink,
  expectNoA11yViolations,
  newUserPage,
  PASSWORD,
  sendMessage,
  signUp,
  openAccountSettings,
} from "./helpers";
import { collectRuntimeErrors } from "./runtime-errors";

// Multi-user flows run on desktop only; the mobile project covers navigation separately.
test.describe("communities", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("onboarding, invites, realtime messaging and moderation", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Olivia Owner");
    await expect(owner.getByRole("heading", { level: 1, name: "Friends" })).toBeVisible();
    await createCommunity(owner, "Garden Club");
    await sendMessage(owner, "Welcome to the garden!");
    const invitePath = await createInviteLink(owner);

    // A new person opens the invite, signs up from it, and lands back on the invite.
    const member = await newUserPage(browser);
    await member.goto(invitePath);
    await expect(member.getByRole("heading", { name: "Garden Club" })).toBeVisible();
    await member.getByRole("link", { name: "Create an account to join" }).click();
    await expect(member).toHaveURL(/\/sign-up\?next=/);
    await signUp(member, "Max Member", member.url().replace(/^https?:\/\/[^/]+/, ""));
    await expect(member).toHaveURL(new RegExp(`${invitePath}$`));
    await member.getByRole("button", { name: "Accept invite" }).click();
    await expect(member.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
    await expect(member.getByText("Welcome to the garden!")).toBeVisible();
    const channelUrl = member.url();

    // Realtime both ways, without reloading.
    await sendMessage(member, "Happy to be here");
    await expect(owner.getByRole("log").getByText("Happy to be here")).toBeVisible();
    await owner.getByRole("textbox", { name: "Message #general" }).fill("Glad you joined");
    await owner.getByRole("textbox", { name: "Message #general" }).press("Enter");
    await expect(member.getByRole("log").getByText("Glad you joined")).toBeVisible();

    // Members can't moderate: no kick/ban controls, no channel management.
    await expect(member.getByRole("button", { name: "Create channel" })).toHaveCount(0);
    await member.getByRole("link", { name: "Community info" }).click();
    await expect(member.getByRole("button", { name: /^Kick / })).toHaveCount(0);
    await member.getByRole("link", { name: "general" }).click();
    await expect(member.getByRole("heading", { level: 1, name: "general" })).toBeVisible();

    // The owner removes the member's message; it disappears for the member live.
    const memberMessage = owner.getByRole("log").getByRole("listitem").filter({ hasText: "Happy to be here" });
    await memberMessage.hover();
    owner.once("dialog", (d) => d.accept());
    await memberMessage.getByRole("button", { name: "Delete message" }).click();
    await expect(member.getByRole("log").getByText("Happy to be here")).toHaveCount(0);

    // The owner kicks the member, who is sent out of the community.
    await owner.getByRole("link", { name: "Community settings" }).click();
    owner.once("dialog", (d) => d.accept("testing kicks"));
    await owner.getByRole("button", { name: "Kick Max Member" }).click();
    await expect(member).toHaveURL(/\/app$/);
    await expect(owner.getByText("testing kicks")).toBeVisible();

    // Their old channel URL now shows "not found" (streamed, so the HTTP status is already sent).
    await member.goto(channelUrl);
    await expect(member.getByText(/could not be found/i)).toBeVisible();
    await expect(member.getByText("Welcome to the garden!")).toHaveCount(0);
  });

  test("recovers messages missed while offline", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Rhea Relay");
    await createCommunity(owner, "Signal Lab");
    const invitePath = await createInviteLink(owner);

    const member = await newUserPage(browser);
    await signUp(member, "Otto Offline");
    await member.goto(invitePath);
    await member.getByRole("button", { name: "Accept invite" }).click();
    await expect(member.getByRole("heading", { level: 1, name: "general" })).toBeVisible();

    await member.context().setOffline(true);
    await expect(member.getByText("Connection lost. Reconnecting…")).toBeVisible();
    await sendMessage(owner, "sent while you were away");
    await member.context().setOffline(false);
    await expect(member.getByRole("log").getByText("sent while you were away")).toBeVisible({ timeout: 15_000 });
    await expect(member.getByText("Connection lost. Reconnecting…")).toBeHidden();
  });

  test("an interrupted read receipt retries without an unhandled rejection", async ({ browser }, info) => {
    const owner = await newUserPage(browser);
    const member = await newUserPage(browser);
    const errors: string[] = [], diagnostics: string[] = [];
    await collectRuntimeErrors(member, errors, diagnostics);
    try {
      await signUp(owner, "Receipt owner");
      await createCommunity(owner, "Receipt recovery");
      const channelUrl = owner.url();
      const invitePath = await createInviteLink(owner);
      await createChannel(owner, "other");
      await owner.getByRole("link", { name: "general", exact: true }).click();
      await signUp(member, "Receipt reader");
      await member.goto(invitePath);
      await member.getByRole("button", { name: "Accept invite" }).click();
      await expect(member.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
      let attempts = 0;
      await member.route(channelUrl, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        attempts++;
        if (attempts === 1) return route.abort("aborted");
        return route.continue();
      });
      const aborted = member.waitForEvent("requestfailed", (request) => request.url() === channelUrl && request.method() === "POST");
      await sendMessage(owner, "Read receipt survives a transport failure");
      await expect(member.getByRole("log")).toContainText("Read receipt survives a transport failure");
      await aborted;
      const retried = member.waitForResponse((response) => response.url() === channelUrl && response.request().method() === "POST");
      await expect.poll(async () => {
        await member.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        return attempts;
      }).toBe(2);
      const response = await retried;
      expect(response.status()).toBe(200);
      await response.finished();
      await member.getByRole("link", { name: "other", exact: true }).click();
      await member.reload();
      await expect(member.getByRole("link", { name: /^general/ })).not.toHaveAccessibleName(/unread|mention/);
      expect(errors).toEqual([]);
    } finally {
      await info.attach("read-receipt-runtime", { body: JSON.stringify({ errors, diagnostics }), contentType: "application/json" });
      await Promise.all([owner.context().close(), member.context().close()]);
    }
  });

  test("message editing, channels and keyboard use", async ({ browser }) => {
    const page = await newUserPage(browser);
    await signUp(page, "Kim Keys");
    await createCommunity(page, "Keyboard Lab");

    await page.getByRole("button", { name: "Create channel" }).click();
    await page.getByLabel("Channel name").fill("Release Notes");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "release-notes" })).toBeVisible();

    // Shift+Enter makes a newline, Enter sends.
    const composer = page.getByRole("textbox", { name: "Message #release-notes" });
    await composer.focus();
    await page.keyboard.type("line one");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("line two");
    await page.keyboard.press("Enter");
    const item = page.getByRole("log").getByRole("listitem").filter({ hasText: "line one" });
    await expect(item).toContainText("line two");

    await item.hover();
    await item.getByRole("button", { name: "Edit message" }).click();
    const editor = page.getByRole("textbox", { name: "Edit message" });
    await editor.fill("edited text");
    await editor.press("Enter");
    await expect(page.getByRole("log")).toContainText("edited text");
    await expect(page.getByRole("log")).toContainText("(edited)");

    // Text is rendered, never interpreted as HTML.
    await sendMessage(page, "<img src=x onerror=alert(1)>");
    await expect(page.locator("img[src=x]")).toHaveCount(0);

    await expectNoA11yViolations(page);
  });

  test("account export and deletion", async ({ browser }) => {
    const page = await newUserPage(browser);
    const email = await signUp(page, "Dana Data");
    await createCommunity(page, "Temporary");
    await sendMessage(page, "exported words");

    await openAccountSettings(page);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download my data" }).click();
    const download = await downloadPromise;
    const exported = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString()));
    expect(exported.format).toBe("opendiscord.user-export");
    expect(exported.messages.map((m: { content: string }) => m.content)).toContain("exported words");
    expect(JSON.stringify(exported)).not.toMatch(/password/i);

    // Deletion is blocked while owning a community.
    await expect(page.getByText(/You own Temporary/)).toBeVisible();
    await expectNoA11yViolations(page);

    await page.getByRole("link", { name: "Temporary" }).click();
    await page.getByRole("link", { name: "Community settings" }).click();
    await page.getByLabel("Type the community name to confirm").fill("Temporary");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/\/app$/);

    await openAccountSettings(page);
    await page.getByLabel("Confirm with your password").fill(PASSWORD);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(page).toHaveURL(/\/$/);

    // The session is gone: the app sends them to sign-in, and the old password no longer works.
    await page.goto("/app");
    await expect(page).toHaveURL(/\/sign-in$/);
    const form = page.locator("form:visible");
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Password").fill(PASSWORD);
    await form.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(form.getByRole("alert")).toBeVisible();
  });
});

test("mobile navigation opens the channel list", async ({ browser, isMobile }) => {
  test.skip(!isMobile, "mobile only");
  const page = await newUserPage(browser);
  await signUp(page, "Mo Bile");
  await createCommunity(page, "Pocket");
  await expect(page.getByRole("navigation", { name: "Channels" })).toBeHidden();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation", { name: "Channels" })).toBeVisible();
  await page.getByRole("navigation", { name: "Channels" }).getByRole("link", { name: "general" }).click();
  await expect(page.getByRole("navigation", { name: "Channels" })).toBeHidden();
  const noHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noHorizontalScroll).toBe(true);
});
