import { randomBytes } from "node:crypto";
import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { Pool } from "pg";
import { createChannel, createCommunity, createInviteLink, joinAsNewUser, newUserPage, openMessageMenu, sendMessage, signUp } from "./helpers";

// Created per test group: with fullyParallel a worker can run this file's groups one after another.
let pool: Pool | null = null;
const db = { query: ((...args: Parameters<Pool["query"]>) => (pool ??= new Pool({ connectionString: process.env.DATABASE_URL })).query(...args)) as Pool["query"] };
test.afterAll(async () => {
  const ended = pool;
  pool = null;
  await ended?.end();
});

/** A UUIDv7 for a given time: the seed controls the order instead of the database clock. */
function uuidv7(ms: number) {
  const time = ms.toString(16).padStart(12, "0");
  const rand = randomBytes(10).toString("hex");
  return `${time.slice(0, 8)}-${time.slice(8)}-7${rand.slice(0, 3)}-${(8 | (parseInt(rand[3], 16) & 3)).toString(16)}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

/** Inserts messages directly: the UI's send rate limit would make 120 messages take minutes. */
async function seed(channelId: string, authorId: string, contents: string[], start: number, threadId: string | null = null) {
  const ids = contents.map((_, i) => uuidv7(start + i * 1000));
  await db.query(
    `insert into message (id, channel_id, author_id, content, created_at, thread_id)
     select id, $1, $2, content, created_at, $3 from unnest($4::uuid[], $5::text[], $6::timestamptz[]) as t(id, content, created_at)`,
    [channelId, authorId, threadId, ids, contents, ids.map((_, i) => new Date(start + i * 1000))],
  );
  return ids;
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A 404 document logs its status as a console error; that one is the expected outcome below.
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of 404/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

/** The invite button sits in the off-canvas navigation on phones. */
async function invite(page: Page) {
  const navigation = page.getByRole("button", { name: "Open navigation" }).first();
  if (await navigation.isVisible()) await navigation.click();
  return createInviteLink(page);
}

/** Channel setup is a desktop flow; the person under test keeps the project's device. */
async function desktopPage(browser: Browser) {
  const { baseURL } = test.info().project.use;
  const ip = `10.251.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const context = await browser.newContext({ ...devices["Desktop Chrome"], baseURL, extraHTTPHeaders: { "X-Forwarded-For": ip } });
  return context.newPage();
}

async function search(page: Page, query: string) {
  await page.getByRole("button", { name: "Search messages" }).click();
  const dialog = page.getByRole("dialog", { name: /^Search / });
  await dialog.getByRole("searchbox", { name: "Search messages" }).fill(query);
  await expect(dialog.getByRole("status")).toHaveText("1 result, newest first.");
  await dialog.getByRole("link").first().click();
  await expect(dialog).toBeHidden();
}

test("search results open the exact message, also old ones, thread replies and after reload", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const owner = await newUserPage(browser);
  const errors = watchErrors(owner);
  const email = await signUp(owner, "Jo Jumper");
  await createCommunity(owner, "Jumps");
  const invitePath = await invite(owner);
  const [, communityId, channelId] = new URL(owner.url()).pathname.match(/^\/app\/c\/([^/]+)\/([^/]+)$/)!;
  const { rows: [{ id: ownerId }] } = await db.query<{ id: string }>(`select id from "user" where email = $1`, [email]);

  const word = `zebracorn${randomBytes(3).toString("hex")}`;
  const contents = Array.from({ length: 120 }, (_, i) => (i === 5 ? `the ancient ${word} note` : `filler message ${i}`));
  const start = Date.now() - 86_400_000;
  const ids = await seed(channelId, ownerId, contents, start);
  const rootIndex = 60;
  const replyWord = `quokka${randomBytes(3).toString("hex")}`;
  const replies = Array.from({ length: 70 }, (_, i) => (i === 3 ? `the ${replyWord} reply` : `thread filler ${i}`));
  const replyIds = await seed(channelId, ownerId, replies, start + 60_500, ids[rootIndex]);
  await owner.reload();
  await expect(owner.getByRole("log").getByText("filler message 119", { exact: true })).toBeVisible();

  // An old hit opens at the message, centered and highlighted.
  await search(owner, word);
  await expect(owner).toHaveURL(`/app/c/${communityId}/${channelId}?m=${ids[5]}`);
  const target = owner.locator(`[data-message-id="${ids[5]}"]`);
  await expect(target).toBeInViewport();
  await expect(target).toHaveAttribute("data-highlighted", "");
  await expect(target).toBeFocused();
  await expect(owner.getByText("filler message 119", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(owner);
  await owner.screenshot({ path: testInfo.outputPath("old-hit.png") });
  await expect(target).not.toHaveAttribute("data-highlighted", { timeout: 8_000 });

  // The link is reload-safe.
  await owner.reload();
  await expect(owner.locator(`[data-message-id="${ids[5]}"]`)).toBeInViewport();

  // Scrolling to the end loads newer pages until the present.
  const log = owner.getByRole("log");
  for (let i = 0; i < 6 && !(await log.getByText("filler message 119", { exact: true }).count()); i++) {
    await owner.locator(".overflow-y-auto").filter({ has: log }).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await owner.waitForTimeout(300);
  }
  await expect(log.getByText("filler message 119", { exact: true })).toBeVisible();

  // A thread reply opens its thread with the reply highlighted.
  await search(owner, replyWord);
  const panel = owner.getByRole("complementary", { name: "Thread by Jo Jumper" });
  await expect(panel).toBeVisible();
  const reply = panel.locator(`[data-message-id="${replyIds[3]}"]`);
  await expect(reply).toBeInViewport();
  await expect(reply).toHaveAttribute("data-highlighted", "");
  await expect(reply).toBeFocused();
  if (testInfo.project.name === "mobile") expect((await panel.boundingBox())!.width).toBe(owner.viewportSize()!.width);
  await expectNoHorizontalOverflow(owner);
  await owner.screenshot({ path: testInfo.outputPath("thread-hit.png") });
  await owner.reload();
  await expect(owner.getByRole("complementary", { name: "Thread by Jo Jumper" }).locator(`[data-message-id="${replyIds[3]}"]`)).toBeInViewport();

  // "Jump to present" returns to the newest page and live messages arrive again.
  await owner.goto(`/app/c/${communityId}/${channelId}?m=${ids[5]}`);
  await expect(owner.locator(`[data-message-id="${ids[5]}"]`)).toBeInViewport();
  await owner.getByRole("button", { name: "Jump to present" }).click();
  await expect(owner).toHaveURL(`/app/c/${communityId}/${channelId}`);
  await expect(owner.getByRole("log").getByText("filler message 119", { exact: true })).toBeInViewport();
  const member = await joinAsNewUser(browser, "Max Member", invitePath);
  await sendMessage(member, "hello from the present");
  await expect(owner.getByRole("log").getByText("hello from the present", { exact: true })).toBeInViewport();
  expect(errors).toEqual([]);
});

test("links to deleted or no longer readable messages reveal nothing", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const owner = await desktopPage(browser);
  await signUp(owner, "Ola Owner");
  await createCommunity(owner, "Leaks");
  const invitePath = await createInviteLink(owner);
  const member = await joinAsNewUser(browser, "Mia Member", invitePath);
  const errors = watchErrors(member);
  const [, communityId, generalId] = new URL(member.url()).pathname.match(/^\/app\/c\/([^/]+)\/([^/]+)$/)!;

  // Deleted in another context: the same notice as for any other unavailable message, without its content.
  await sendMessage(owner, "short-lived walrus");
  const row = owner.getByRole("log").locator("li[data-message-id]").filter({ hasText: "short-lived walrus" });
  const deletedId = await row.getAttribute("data-message-id");
  owner.once("dialog", (dialog) => void dialog.accept());
  await openMessageMenu(row);
  await owner.getByRole("menuitem", { name: "Delete message", exact: true }).click();
  await expect(row).toHaveCount(0);
  await member.goto(`/app/c/${communityId}/${generalId}?m=${deletedId}`);
  await expect(member.getByRole("status").filter({ hasText: "This message is no longer available." })).toBeVisible();
  await expect(member.getByText("short-lived walrus")).toHaveCount(0);
  await expectNoHorizontalOverflow(member);
  await member.screenshot({ path: testInfo.outputPath("unavailable.png") });

  // A message id from another channel gets the same notice, not that channel's content.
  await createChannel(owner, "secret");
  const secretId = new URL(owner.url()).pathname.split("/").at(-1)!;
  await sendMessage(owner, "classified narwhal");
  const secretMessageId = await owner.getByRole("log").locator("li[data-message-id]").filter({ hasText: "classified narwhal" }).getAttribute("data-message-id");
  await member.goto(`/app/c/${communityId}/${generalId}?m=${secretMessageId}`);
  await expect(member.getByRole("status").filter({ hasText: "This message is no longer available." })).toBeVisible();
  await expect(member.getByText("classified narwhal")).toHaveCount(0);

  // Readable at first, then the channel is hidden from everyone: the link is a plain 404.
  await member.goto(`/app/c/${communityId}/${secretId}?m=${secretMessageId}`);
  await expect(member.locator(`[data-message-id="${secretMessageId}"]`)).toBeInViewport();
  await owner.getByRole("button", { name: "Channel settings" }).click();
  await owner.getByRole("dialog").getByLabel("View for everyone").selectOption("deny");
  await expect(owner.getByRole("dialog").getByText(/^Private:/)).toBeVisible();
  await owner.keyboard.press("Escape");
  await member.goto(`/app/c/${communityId}/${secretId}?m=${secretMessageId}`);
  await expect(member.getByText("This page could not be found")).toBeVisible();
  await expect(member.getByText("classified narwhal")).toHaveCount(0);
  await expectNoHorizontalOverflow(member);
  expect(errors).toEqual([]);
});

test("a view opened at an old message reads only what was seen, and Mark as read reaches the present", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const owner = await desktopPage(browser);
  const email = await signUp(owner, "Old Poster");
  await createCommunity(owner, "Jump reads");
  const invitePath = await invite(owner);
  const [, communityId, channelId] = new URL(owner.url()).pathname.match(/^\/app\/c\/([^/]+)\/([^/]+)$/)!;
  const { rows: [{ id: ownerId }] } = await db.query<{ id: string }>(`select id from "user" where email = $1`, [email]);
  const ids = await seed(channelId, ownerId, Array.from({ length: 120 }, (_, i) => `history ${i}`), Date.now() - 86_400_000);

  const readerName = `Late Reader ${randomBytes(3).toString("hex")}`;
  const member = await joinAsNewUser(browser, readerName, invitePath);
  const errors = watchErrors(member);
  const { rows: [{ id: memberId }] } = await db.query<{ id: string }>(`select id from "user" where name = $1`, [readerName]);
  const marker = async () => (await db.query<{ id: string }>(
    "select last_read_id as id from channel_read_state where user_id = $1 and channel_id = $2", [memberId, channelId])).rows[0]?.id ?? null;
  // Joining opened the channel at its present; once that mark has landed, start from an older marker.
  await expect.poll(marker).toBe(ids[119]);
  await member.goto("/app");
  await db.query("update channel_read_state set last_read_id = $1 where user_id = $2 and channel_id = $3", [ids[0], memberId, channelId]);

  await member.goto(`/app/c/${communityId}/${channelId}?m=${ids[5]}`);
  await expect(member.locator(`[data-message-id="${ids[5]}"]`)).toBeInViewport();
  // Only what is on screen counts: at most the loaded page around the hit, never the newest message.
  await expect.poll(marker).not.toBe(ids[0]);
  expect(ids.indexOf((await marker())!)).toBeLessThan(60);
  await member.reload();
  await expect(member.locator(`[data-message-id="${ids[5]}"]`)).toBeInViewport();
  expect(ids.indexOf((await marker())!)).toBeLessThan(60);

  // "Mark as read" from this view marks the channel's newest message, which isn't loaded here.
  await member.getByRole("button", { name: "Mark as read" }).click();
  await expect.poll(marker).toBe(ids[119]);
  await expect(member.getByRole("button", { name: "Mark as read" })).toBeHidden();
  await expectNoHorizontalOverflow(member);
  await member.screenshot({ path: testInfo.outputPath("jump-marked.png") });
  expect(errors).toEqual([]);
  await member.context().close();
  await owner.context().close();
});
