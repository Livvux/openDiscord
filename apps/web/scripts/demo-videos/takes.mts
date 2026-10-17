// The takes. Each seeds its own people and community, then records one user's screen.
import { expect, type Browser, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  OUT, glideClick, pause, record, scenario, send, showCursor, signedInUser, typeAndSend, waitLive, type User,
} from "./lib.mjs";

const log = (page: Page) => page.getByRole("log").first();
const message = (page: Page, text: string) => log(page).getByRole("listitem").filter({ hasText: text }).last();

/** Opens the channel fresh with the cursor overlay installed, ready to roll. */
async function stage(user: User, url: string, warmReactions = true) {
  await showCursor(user.page);
  await user.page.goto(url);
  await waitLive(user.page);
  await expect(log(user.page)).toBeVisible();
  if (warmReactions) {
    // The emoji bar loads lazily on first use; do that off camera so the take never shows "Loading emojis…".
    const last = log(user.page).getByRole("listitem").last();
    await last.hover();
    await last.getByRole("button", { name: "Add reaction" }).click();
    await expect(user.page.getByRole("button", { name: /thumbs up/i }).first()).toBeVisible();
    await user.page.keyboard.press("Escape");
    await expect(user.page.getByRole("button", { name: /thumbs up/i })).toHaveCount(0);
    // The picker leaves the toolbar pinned open; hopping to another channel and back (client-side, so the loaded
    // emoji data stays in memory) clears it.
    const channels = user.page.getByRole("navigation", { name: "Channels" });
    await channels.getByRole("link", { name: "announcements" }).click();
    await expect(user.page.getByRole("heading", { level: 1, name: "announcements" })).toBeVisible();
    await channels.getByRole("link", { name: "general" }).click();
    await expect(user.page.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
    await waitLive(user.page);
    await expect(log(user.page).getByRole("listitem").last()).toBeVisible();
  }
  await user.page.mouse.move(180, 540);
  await pause(600);
}

async function react(page: Page, text: string, emoji: RegExp) {
  const item = message(page, text);
  await item.hover();
  await glideClick(page, item.getByRole("button", { name: "Add reaction" }));
  const choice = page.getByRole("button", { name: emoji }).first();
  await expect(choice).toBeVisible();
  await pause(350);
  await glideClick(page, choice);
}

export async function chat(browser: Browser) {
  const s = await scenario(browser, { members: ["jonas", "Ife", "Kai"] });
  const { jonas, Ife, Kai } = s.members;
  for (const [who, text] of [
    [s.owner, "Welcome to Study Hall. Rules are pinned in #announcements."],
    [Ife, "Exam is on the 24th, right?"],
    [Kai, "Yep, 9am. Room B12."],
    [Ife, "Ugh, that's early. Coffee run before?"],
    [Kai, "Always. 8:15 at the usual place."],
    [jonas, "I set up our notes server last night. Same release as the hosted one."],
    [Ife, "Nice. Can I get on it from my phone?"],
    [s.owner, "Yes. Same invite link, any device."],
    [jonas, "Also pushed the flashcards to the shared folder."],
    [Kai, "You're a legend."],
  ] as const) { await send(who.page, text); await pause(120); }
  await stage(s.owner, s.communityUrl);

  return record(s.owner.page, "chat.mp4", async () => {
    const p = s.owner.page;
    await pause(900);
    await send(jonas.page, "Study session tonight? Library, 7pm");
    await pause(1500);
    await send(Ife.page, "I'm in 🙌");
    await pause(1200);
    await typeAndSend(p, "Count me in. I'll bring my chapter 4 notes");
    await pause(900);
    await react(p, "Study session tonight", /party popper/i);
    await pause(700);
    await send(Kai.page, "Booked room B12 ✅");
    await p.mouse.move(180, 540, { steps: 30 });
    await pause(1500);
  });
}

export async function threads(browser: Browser) {
  const s = await scenario(browser, { members: ["jonas", "Ife", "Kai"] });
  const { jonas, Ife, Kai } = s.members;
  for (const [who, text] of [
    [s.owner, "Reminder: problem set 3 is due Friday."],
    [Kai, "Anyone else lost on the hash map lecture?"],
    [jonas, "Same. The recursion part especially."],
    [Ife, "I can walk through it if you want."],
    [s.owner, "Let's meet Thursday and go through the slides."],
    [Kai, "Works for me."],
    [jonas, "Library, second floor?"],
    [Ife, "Who has notes for chapter 4? I missed Tuesday."],
  ] as const) { await send(who.page, text); await pause(120); }
  await stage(s.owner, s.communityUrl);
  await jonas.page.reload();
  await waitLive(jonas.page);

  return record(s.owner.page, "threads.mp4", async () => {
    const p = s.owner.page;
    await pause(900);
    const root = message(p, "Who has notes for chapter 4");
    await root.hover();
    await glideClick(p, root.getByRole("button", { name: "Start a thread" }));
    const panel = p.getByRole("complementary").first();
    const box = panel.getByRole("textbox", { name: "Reply in thread" });
    await expect(box).toBeVisible();
    await pause(500);
    await glideClick(p, box);
    await box.pressSequentially("I do. Uploading them to the shared folder tonight", { delay: 50 });
    await pause(300);
    await box.press("Enter");
    await expect(panel.getByText("Uploading them")).toBeVisible();
    await pause(900);
    // jonas opens the same thread from the channel summary and answers; it lands live in Mara's panel.
    await message(jonas.page, "Who has notes for chapter 4").getByRole("button", { name: /1 reply/ }).click();
    const theirs = jonas.page.getByRole("complementary").first().getByRole("textbox", { name: "Reply in thread" });
    await theirs.fill("Can you add the diagrams too?");
    await theirs.press("Enter");
    await expect(panel.getByText("add the diagrams")).toBeVisible();
    await pause(900);
    const reply = panel.getByRole("log", { name: "Thread replies" }).getByRole("listitem").filter({ hasText: "add the diagrams" });
    await reply.hover();
    await glideClick(p, reply.getByRole("button", { name: "Add reaction" }));
    await pause(450);
    await glideClick(p, p.getByRole("button", { name: /thumbs up/i }).first());
    await pause(1300);
    await p.keyboard.press("Escape");
    await p.mouse.move(180, 540, { steps: 25 });
    await pause(1400);
  });
}

export async function moderation(browser: Browser) {
  const s = await scenario(browser, { members: ["Ife", "Kai", "Toby"] });
  const { Ife, Kai, Toby } = s.members;
  await send(Toby.page, "free followers!! click my profile");
  const base = s.communityUrl.replace(/\/[^/]+$/, "");
  // Off camera: a Moderator role for Ife, and Toby banned with a reason (the ban reason is a native prompt, which video can't show).
  const admin = s.owner.page;
  await admin.goto(`${base}/settings`);
  await admin.locator("#new-role-name").fill("Moderator");
  await admin.getByRole("button", { name: "Create role" }).click();
  await expect(admin.getByRole("checkbox", { name: "Moderator" }).first()).toBeVisible();
  const ife = admin.getByRole("group", { name: "Roles for Ife" }).getByLabel("Moderator");
  await ife.click();
  await expect(ife).toBeChecked();
  admin.once("dialog", (d) => d.accept("Spam links in #general"));
  await admin.getByRole("button", { name: "Ban Toby" }).click();
  await expect(admin.getByRole("button", { name: "Ban Toby" })).toHaveCount(0);
  await send(Kai.page, "Thanks for the quick cleanup");
  void Ife;

  await showCursor(admin);
  await admin.goto(`${base}/settings`);
  await expect(admin.getByRole("heading", { name: "Audit log" })).toBeAttached();
  await scrollTo(admin, /^Members/);
  await admin.mouse.move(1050, 330);
  return record(admin, "moderation.mp4", async () => {
    await pause(1100);
    const kai = admin.getByRole("group", { name: "Roles for Kai" }).getByLabel("Moderator");
    await kai.scrollIntoViewIfNeeded();
    await glideClick(admin, kai);
    await pause(1500);
    await scrollTo(admin, "Bans");
    await pause(1900);
    await scrollTo(admin, "Audit log");
    await pause(2800);
  });
}

/** Wheel-scrolls the settings pane (eased) until the section heading sits near the top. */
async function scrollTo(page: Page, heading: string | RegExp) {
  const h = page.getByRole("heading", { name: heading, exact: typeof heading === "string" ? true : undefined });
  for (let i = 0; i < 400; i++) {
    const top = (await h.first().boundingBox())?.y ?? 9999;
    const rest = top - 110;
    if (Math.abs(rest) < 4) break;
    await page.mouse.wheel(0, Math.sign(rest) * Math.min(Math.abs(rest), Math.max(5, Math.abs(rest) * 0.07)));
    await pause(16);
  }
}

export async function invite(browser: Browser) {
  const s = await scenario(browser, { members: ["jonas", "Ife"] });
  const { jonas, Ife } = s.members;
  for (const [who, text] of [
    [s.owner, "Welcome to Study Hall."],
    [Ife, "Notes for chapter 4 are in the shared folder."],
    [jonas, "Thanks! Thursday still on?"],
    [s.owner, "Yes, library, second floor."],
    [Ife, "I'll bring the flashcards."],
    [jonas, "And I'll bring snacks."],
    [s.owner, "Perfect. Someone should invite Kai from our seminar."],
  ] as const) { await send(who.page, text); await pause(120); }
  const kai = await signedInUser(browser, "Kai");
  await showCursor(s.owner.page);
  await s.owner.page.goto(s.communityUrl);
  await waitLive(s.owner.page);
  await s.owner.page.mouse.move(180, 540);

  // Part 1: Mara creates a link.
  const a = await record(s.owner.page, "invite-a.mp4", async () => {
    const p = s.owner.page;
    await pause(800);
    await glideClick(p, p.getByRole("button", { name: "Invite people" }));
    await pause(700);
    await glideClick(p, p.getByRole("button", { name: /Create (another )?invite link|Create invite link/ }));
    await expect(p.getByLabel("Invite link")).toBeVisible();
    await pause(1100);
    await glideClick(p, p.getByRole("button", { name: "Copy" }));
    await pause(1000);
    await p.keyboard.press("Escape");
    await pause(300);
  });
  const link = s.invite;

  // Part 2: Kai opens it and joins.
  await showCursor(kai.page);
  await kai.page.goto(link);
  await expect(kai.page.getByRole("button", { name: "Accept invite" })).toBeVisible();
  await kai.page.mouse.move(1100, 700);
  const b = await record(kai.page, "invite-b.mp4", async () => {
    const p = kai.page;
    await pause(1100);
    await glideClick(p, p.getByRole("button", { name: "Accept invite" }));
    await expect(p.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
    await waitLive(p);
    await pause(900);
    await typeAndSend(p, "Hi all, thanks for the invite!");
    await pause(500);
    await send(s.owner.page, "Welcome, Kai!");
    await pause(1800);
  });
  const out = join(OUT, "invite.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", a, "-i", b, "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]", "-map", "[v]", "-c:v", "libx264", "-crf", "23", "-preset", "slow", "-movflags", "+faststart", "-an", out]);
  return out;
}
