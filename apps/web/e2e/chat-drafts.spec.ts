import { expect, test, type Page } from "@playwright/test";
import { createChannel, createCommunity, createInviteLink, finishSignOut, joinAsNewUser, newUserPage, openAccountMenu, sendMessage, signUp } from "./helpers";

const OUTBOX_PREFIX = "od.outbox.v1:";

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Offline and aborted requests log the browser's own network failures; anything else is a bug.
  page.on("console", (entry) => { if (entry.type() === "error" && !/net::ERR_|Failed to load resource/.test(entry.text())) errors.push(entry.text()); });
  return errors;
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const outboxKeys = (page: Page) => page.evaluate((prefix) => Object.keys(sessionStorage).filter((key) => key.startsWith(prefix)), OUTBOX_PREFIX);

/** In-app navigation (no reload): the channel list is off-canvas on phones. */
async function openChannel(page: Page, name: string) {
  const nav = page.getByRole("navigation", { name: "Channels" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Open navigation" }).first().click();
  await nav.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

async function addChannel(page: Page, name: string) {
  const create = page.getByRole("button", { name: "Create channel" });
  if (!(await create.isVisible())) await page.getByRole("button", { name: "Open navigation" }).first().click();
  await createChannel(page, name);
}

async function messageAction(page: Page, text: string, action: string) {
  await page.getByRole("log").locator("[data-message-id]").filter({ hasText: text }).getByText(text, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

test("drafts and reply references stay with their channel and thread", async ({ browser }, info) => {
  const page = await newUserPage(browser);
  const errors = watchErrors(page);
  try {
    await signUp(page, "Draft Keeper");
    await createCommunity(page, "Draft QA");
    await sendMessage(page, "Reply target");
    await addChannel(page, "random");
    await openChannel(page, "general");

    const general = page.getByRole("textbox", { name: "Message #general" });
    await messageAction(page, "Reply target", "Reply");
    await general.fill("General draft");
    await openChannel(page, "random");
    const random = page.getByRole("textbox", { name: "Message #random" });
    await expect(random).toHaveValue("");
    await expect(page.getByRole("button", { name: "Cancel reply" })).toHaveCount(0);
    await random.fill("Random draft");

    await openChannel(page, "general");
    await expect(general).toHaveValue("General draft");
    await expect(page.getByText("Replying to")).toBeVisible();

    await messageAction(page, "Reply target", "Start a thread");
    const panel = page.getByRole("complementary", { name: "Thread by Draft Keeper" });
    const thread = panel.getByRole("textbox", { name: "Reply in thread" });
    await expect(thread).toHaveValue("");
    await thread.fill("Thread draft");
    await panel.getByRole("button", { name: "Close thread" }).click();
    await expect(general).toHaveValue("General draft");
    await messageAction(page, "Reply target", "Start a thread");
    await expect(thread).toHaveValue("Thread draft");
    await panel.getByRole("button", { name: "Close thread" }).click();

    await openChannel(page, "random");
    await expect(random).toHaveValue("Random draft");
    expect(await noHorizontalOverflow(page)).toBe(true);
    await openChannel(page, "general");
    await page.screenshot({ path: info.outputPath("draft-restored.png") });

    // Sending clears the draft and its reply reference.
    await general.press("Enter");
    await expect(page.getByRole("log").locator("[data-message-id]").filter({ hasText: "General draft" })).toHaveCount(1);
    await openChannel(page, "random");
    await openChannel(page, "general");
    await expect(general).toHaveValue("");
    await expect(page.getByRole("button", { name: "Cancel reply" })).toHaveCount(0);
    // Drafts are memory-only.
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("draft");
    expect(errors).toEqual([]);
  } finally { await page.context().close(); }
});

test("an interrupted send survives a reload and retries without a duplicate", async ({ browser }, info) => {
  test.setTimeout(90_000);
  const owner = await newUserPage(browser);
  const errors = watchErrors(owner);
  try {
    await signUp(owner, "Outbox Owner");
    await createCommunity(owner, "Outbox QA");
    // The invite button lives in the off-canvas channel list on phones.
    if (!(await owner.getByRole("button", { name: "Invite people" }).isVisible())) await owner.getByRole("button", { name: "Open navigation" }).first().click();
    const member = await joinAsNewUser(browser, "Outbox Member", await createInviteLink(owner));
    const text = "Delivered once across a reload";
    let interrupted = false;
    await owner.route("**/app/**", async (route) => {
      const request = route.request();
      if (!interrupted && request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes(text)) {
        await route.fetch();
        interrupted = true;
        await route.abort("failed");
      } else await route.continue();
    });
    const composer = owner.getByRole("textbox", { name: "Message #general" });
    await composer.fill(text);
    await composer.press("Enter");
    await expect(owner.getByRole("button", { name: "Retry message", exact: true })).toBeVisible();
    await owner.reload();

    // Restored, never resent on its own.
    const retry = owner.getByRole("button", { name: "Retry message", exact: true });
    await expect(retry).toBeVisible();
    await expect(owner.getByLabel("Delivery unconfirmed", { exact: true })).toContainText(text);
    await expect(owner.getByRole("button", { name: "Discard message", exact: true })).toBeVisible();
    expect(await noHorizontalOverflow(owner)).toBe(true);
    await owner.screenshot({ path: info.outputPath("outbox-restored.png") });
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(owner.getByLabel("Delivery unconfirmed", { exact: true })).toHaveCount(0);
    await expect(owner.getByLabel("Sending", { exact: true })).toHaveCount(0);
    await expect(owner.locator("[data-message-id]").filter({ hasText: text })).toHaveCount(1);
    expect(await owner.evaluate((prefix) => Object.entries(sessionStorage).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value).join(""), OUTBOX_PREFIX)).not.toContain(text);

    await member.reload();
    await expect(member.locator("[data-message-id]").filter({ hasText: text })).toHaveCount(1);
    await member.context().close();
    expect(errors).toEqual([]);
  } finally { await owner.context().close(); }
});

test("an offline send stays restorable across navigation and sign-out clears it", async ({ browser }, info) => {
  const page = await newUserPage(browser);
  const errors = watchErrors(page);
  try {
    await signUp(page, "Offline Sender");
    await createCommunity(page, "Offline QA");
    await addChannel(page, "random");
    await openChannel(page, "general");
    const composer = page.getByRole("textbox", { name: "Message #general" });

    const text = "Written while offline";
    await page.context().setOffline(true);
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: "Retry message", exact: true })).toBeVisible();
    await page.context().setOffline(false);

    await openChannel(page, "random");
    await openChannel(page, "general");
    await expect(page.getByLabel("Delivery unconfirmed", { exact: true })).toContainText(text);
    await page.screenshot({ path: info.outputPath("outbox-offline.png") });
    await page.getByRole("button", { name: "Retry message", exact: true }).click();
    await expect(page.getByRole("log").locator("[data-message-id]").filter({ hasText: text })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Retry message", exact: true })).toHaveCount(0);

    // A second unconfirmed send is stored for this tab until sign-out.
    const later = "Unsent at sign-out";
    await page.context().setOffline(true);
    await composer.fill(later);
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: "Retry message", exact: true })).toBeVisible();
    await page.context().setOffline(false);
    expect(await outboxKeys(page)).toHaveLength(1);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await openAccountMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await finishSignOut(page);
    expect(await outboxKeys(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await page.context().close(); }
});

test("a retry the server refuses offers Edit and Discard", async ({ browser }, info) => {
  const page = await newUserPage(browser);
  const errors = watchErrors(page);
  try {
    await signUp(page, "Refused Retry");
    await createCommunity(page, "Refusal QA");
    const text = "Sent, then deleted before the retry";
    let interrupted = false;
    await page.route("**/app/**", async (route) => {
      const request = route.request();
      if (!interrupted && request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes(text)) {
        await route.fetch();
        interrupted = true;
        await route.abort("failed");
      } else await route.continue();
    });
    const composer = page.getByRole("textbox", { name: "Message #general" });
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: "Retry message", exact: true })).toBeVisible();
    // The send did arrive (live update); deleting it makes the retry definitive.
    page.once("dialog", (dialog) => dialog.accept());
    await messageAction(page, text, "Delete message");
    await expect(page.locator("[data-message-id]").filter({ hasText: text })).toHaveCount(0);
    await page.getByRole("button", { name: "Retry message", exact: true }).click();
    await expect(page.getByLabel("Sent, then deleted", { exact: true })).toContainText(text);
    await expect(page.getByRole("alert").getByRole("button", { name: "Discard message", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry message", exact: true })).toHaveCount(0);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await page.screenshot({ path: info.outputPath("outbox-refused.png") });
    await page.getByRole("button", { name: "Edit unsent message", exact: true }).click();
    await expect(composer).toHaveValue(text);
    await expect(page.getByLabel("Sent, then deleted", { exact: true })).toHaveCount(0);
    expect(await outboxKeys(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await page.context().close(); }
});
