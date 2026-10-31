import { randomBytes } from "node:crypto";
import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { Pool } from "pg";
import { createChannel, createCommunity, createInviteLink, newUserPage, sendMessage, signUp, waitForLive } from "./helpers";
import { collectRuntimeErrors } from "./runtime-errors";

// The read marker may only move to messages that were on screen in a visible tab, or by "Mark as read".
const HISTORY = 65;
// Longer than the client's read debounce plus a server round trip: a wrongly sent marker would have landed.
const SETTLE_MS = 1500;
const db = new Pool({ connectionString: process.env.DATABASE_URL });
test.afterAll(() => db.end());

interface Room { sender: Page; reader: Page; readerId: string; communityId: string; channelId: string; errors: string[] }

async function userId(email: string): Promise<string> {
  return (await db.query<{ id: string }>('select id from "user" where email=$1', [email])).rows[0].id;
}

async function marker(room: Room): Promise<string | null> {
  const { rows } = await db.query<{ last_read_id: string }>(
    "select last_read_id from channel_read_state where user_id=$1 and channel_id=$2", [room.readerId, room.channelId]);
  return rows[0]?.last_read_id ?? null;
}

async function messageId(room: Room, content: string): Promise<string> {
  return (await db.query<{ id: string }>("select id from message where channel_id=$1 and content=$2", [room.channelId, content])).rows[0].id;
}

/** UUIDv7 with a chosen timestamp: the database's uuidv7() is not monotonic within one millisecond. */
function uuidv7At(ms: number) {
  const time = ms.toString(16).padStart(12, "0");
  const rand = randomBytes(8).toString("hex");
  return `${time.slice(0, 8)}-${time.slice(8)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(4, 16)}`;
}

/** The sender always uses the desktop layout (its helpers drive the sidebar); the reader uses the project's device. */
async function desktopPage(browser: Browser, ip: string) {
  const context = await browser.newContext({ ...devices["Desktop Chrome"], baseURL: test.info().project.use.baseURL, extraHTTPHeaders: { "X-Forwarded-For": ip } });
  return context.newPage();
}

/** Sender owns a community with more than one page of #general history; reader joined and sits at its bottom. */
async function setup(browser: Browser): Promise<Room> {
  const sender = await desktopPage(browser, `10.251.${process.pid % 250}.${test.info().workerIndex % 250}`);
  const senderEmail = await signUp(sender, "Sam Sender");
  await createCommunity(sender, "Read State");
  const [, , , communityId, channelId] = new URL(sender.url()).pathname.split("/");
  const invitePath = await createInviteLink(sender);
  await createChannel(sender, "other");
  await sender.goto(`/app/c/${communityId}/${channelId}`);
  const senderId = await userId(senderEmail);
  // Backdated so the seed neither trips the author rate limit nor looks live.
  const start = Date.now() - 3_600_000;
  for (let i = 0; i < HISTORY; i++) {
    await db.query("insert into message (id, channel_id, author_id, content, created_at) values ($1, $2, $3, $4, $5)",
      [uuidv7At(start + i * 1000), channelId, senderId, `History ${i}`, new Date(start + i * 1000)]);
  }
  const reader = await newUserPage(browser);
  const errors: string[] = [];
  await collectRuntimeErrors(reader, errors);
  reader.on("console", (message) => {
    // Offline steps make the browser log its own failed requests; those are the point of the test.
    if (message.type() === "error" && !/ERR_INTERNET_DISCONNECTED|Failed to load resource|ERR_NETWORK_CHANGED/.test(message.text())) errors.push(message.text());
  });
  const readerEmail = await signUp(reader, "Rae Reader");
  await reader.goto(invitePath);
  await reader.getByRole("button", { name: "Accept invite" }).click();
  // The first community render is the slowest step when several specs share the server.
  await expect(reader.getByRole("heading", { level: 1, name: "general" })).toBeVisible({ timeout: 30_000 });
  await waitForLive(reader);
  await expect(log(reader).getByText(`History ${HISTORY - 1}`, { exact: true })).toBeVisible();
  const room = { sender, reader, readerId: await userId(readerEmail), communityId, channelId, errors };
  // At the bottom the newest history message is on screen, so it is read.
  const newestHistory = await messageId(room, `History ${HISTORY - 1}`);
  await expect.poll(() => marker(room)).toBe(newestHistory);
  return room;
}

const log = (page: Page) => page.getByRole("log", { name: "Messages in #general" });
const scroller = (page: Page) => log(page).locator("xpath=../..");

async function scrollToTop(page: Page) {
  await scroller(page).evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(page.getByText("You're viewing older messages")).toBeVisible();
}

async function scrollToBottom(page: Page) {
  await scroller(page).evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
}

/** Phones keep the channel list in the off-canvas navigation. */
async function channelLink(page: Page, name: string) {
  const link = page.getByRole("link", { name: new RegExp(`^${name}`) });
  const toggle = page.getByRole("button", { name: "Open navigation", exact: true });
  // After a reload neither may be rendered yet; absence is not a phone layout.
  await expect.poll(async () => (await link.isVisible()) || (await toggle.isVisible())).toBe(true);
  if (!(await link.isVisible())) await toggle.click();
  return link;
}

async function openChannel(page: Page, name: string) {
  await (await channelLink(page, name)).click();
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((hidden) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

async function close(room: Room | undefined) {
  await Promise.all([room?.sender.context().close(), room?.reader.context().close()]);
}

test.describe("read markers follow what was seen", () => {
  test.describe.configure({ timeout: 120_000 });

  test("reading older messages leaves newer ones unread until they are scrolled into view", async ({ browser }, info) => {
    let room: Room | undefined;
    try {
      room = await setup(browser);
      const { reader, sender } = room;
      const before = await marker(room);
      await scrollToTop(reader);
      await sendMessage(sender, "Posted while you read history");
      await expect(log(reader).getByText("Posted while you read history", { exact: true })).toBeAttached();
      await reader.waitForTimeout(SETTLE_MS);
      expect(await marker(room)).toBe(before);
      await expect(reader.getByRole("button", { name: "Mark as read" })).toBeVisible();
      await reader.screenshot({ path: info.outputPath("read-state-unseen-bar.png") });

      // The open channel was not being watched at the present, so leaving it shows it unread right away.
      await openChannel(reader, "other");
      await expect(await channelLink(reader, "general")).toHaveAccessibleName(/unread/);
      await reader.reload();
      await expect(reader.getByRole("heading", { level: 1, name: "other", exact: true })).toBeVisible();
      await expect(await channelLink(reader, "general")).toHaveAccessibleName(/unread/);

      // The divider points at the first message that was never seen; opening at the bottom then reads it.
      await openChannel(reader, "general");
      const divider = log(reader).getByRole("listitem").filter({ hasText: /^New messages$/ });
      await expect(divider.locator("xpath=following-sibling::li[1]")).toContainText("Posted while you read history");
      const posted = await messageId(room, "Posted while you read history");
      await expect.poll(() => marker(room!)).toBe(posted);

      // Scrolling back down to a message seen only now moves the marker, and it persists.
      await scrollToTop(reader);
      await sendMessage(sender, "Seen after scrolling down");
      await expect(log(reader).getByText("Seen after scrolling down", { exact: true })).toBeAttached();
      await reader.waitForTimeout(SETTLE_MS);
      expect(await marker(room)).toBe(posted);
      await scrollToBottom(reader);
      const seen = await messageId(room, "Seen after scrolling down");
      await expect.poll(() => marker(room!)).toBe(seen);
      await expect(reader.getByRole("button", { name: "Mark as read" })).toBeHidden();
      await openChannel(reader, "other");
      await reader.reload();
      await expect(await channelLink(reader, "general")).not.toHaveAccessibleName(/unread|mention/);
      expect(room.errors).toEqual([]);
    } finally {
      await close(room);
    }
  });

  test("a hidden tab and a reconnect while scrolled up keep new messages unread", async ({ browser }) => {
    let room: Room | undefined;
    try {
      room = await setup(browser);
      const { reader, sender } = room;
      const before = await marker(room);
      await setHidden(reader, true);
      await sendMessage(sender, "Posted to a background tab");
      await expect(log(reader).getByText("Posted to a background tab", { exact: true })).toBeAttached();
      await reader.waitForTimeout(SETTLE_MS);
      expect(await marker(room)).toBe(before);
      // Back in the foreground at the bottom, the message is on screen and becomes read.
      await setHidden(reader, false);
      const background = await messageId(room, "Posted to a background tab");
      await expect.poll(() => marker(room!)).toBe(background);

      await scrollToTop(reader);
      await reader.context().setOffline(true);
      await expect(reader.getByText("Connection lost. Reconnecting…")).toBeVisible();
      await sendMessage(sender, "Posted while you were offline");
      await reader.context().setOffline(false);
      await expect(log(reader).getByText("Posted while you were offline", { exact: true })).toBeAttached({ timeout: 15_000 });
      await expect(reader.getByText("Connection lost. Reconnecting…")).toBeHidden();
      await reader.waitForTimeout(SETTLE_MS);
      expect(await marker(room)).toBe(background);

      // "New messages" jumps to the first unseen message, which is then on screen and read.
      await reader.getByRole("button", { name: "Jump to new messages" }).click();
      await expect(log(reader).getByText("Posted while you were offline", { exact: true })).toBeInViewport();
      const offline = await messageId(room, "Posted while you were offline");
      await expect.poll(() => marker(room!)).toBe(offline);
      expect(room.errors).toEqual([]);
    } finally {
      await close(room);
    }
  });

  test("Mark as read reads everything loaded and persists", async ({ browser }, info) => {
    let room: Room | undefined;
    try {
      room = await setup(browser);
      const { reader, sender } = room;
      await scrollToTop(reader);
      await sendMessage(sender, "Read without scrolling");
      await expect(log(reader).getByText("Read without scrolling", { exact: true })).toBeAttached();
      const bar = reader.getByRole("button", { name: "Mark as read" });
      await bar.click();
      const latest = await messageId(room, "Read without scrolling");
      await expect.poll(() => marker(room!)).toBe(latest);
      await expect(bar).toBeHidden();
      // Still reading history: the marker moved without moving the view.
      await expect(reader.getByText("You're viewing older messages")).toBeVisible();
      await reader.screenshot({ path: info.outputPath("read-state-marked.png") });
      await openChannel(reader, "other");
      await expect(await channelLink(reader, "general")).not.toHaveAccessibleName(/unread|mention/);
      await reader.reload();
      await expect(await channelLink(reader, "general")).not.toHaveAccessibleName(/unread|mention/);
      expect(room.errors).toEqual([]);
    } finally {
      await close(room);
    }
  });
});
