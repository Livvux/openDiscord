// Shared helpers for the demo-video recorder. Runs against a local production build (see README.md).
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { REGISTRATION_HEADER, registrationAttestation } from "../../src/lib/registration-policy";

// The browser reaches the local build as opendiscord.app (host-resolver rule and TLS proxy, see proxy.mts), so invite links read like production.
export const BASE = "https://opendiscord.app";
export const VIEWPORT = { width: 1440, height: 900 };
export const PASSWORD = "correct horse battery";
const CAPTCHA = { "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX", [REGISTRATION_HEADER]: registrationAttestation(16) };

let counter = 0;
const run = Date.now().toString(36);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export { pause };

export async function launch() {
  return chromium.launch({ args: ["--host-resolver-rules=MAP opendiscord.app 127.0.0.1:8443", "--ignore-certificate-errors"] });
}

/** A signed-in user in their own context (own fake client IP, so sign-ups don't trip the auth rate limit). */
export async function signedInUser(browser: Browser, name: string) {
  counter += 1;
  const ip = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${(counter % 250) + 1}`;
  const headers = { "X-Forwarded-For": ip };
  // Sign up from inside the browser: only it resolves opendiscord.app, and the auth origin check wants that host.
  const seedCtx = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: headers, ignoreHTTPSErrors: true });
  const seedPage = await seedCtx.newPage();
  await seedPage.goto("/sign-in");
  const result = await seedPage.evaluate(async ({ headers, body }) => {
    const r = await fetch("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status, text: r.ok ? "" : await r.text() };
  }, { headers: CAPTCHA, body: { name, email: `${name.toLowerCase()}-${run}-${counter}@example.test`, password: PASSWORD } });
  if (!result.ok) throw new Error(`sign-up ${name} failed: ${result.status} ${result.text}`);
  const state = await seedCtx.storageState();
  await seedCtx.close();
  return newPage(browser, state, headers);
}

export async function newPage(browser: Browser, storageState: Awaited<ReturnType<BrowserContext["storageState"]>>, headers: Record<string, string>) {
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    storageState,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: headers,
  });
  return { context, page: await context.newPage(), storageState, headers };
}

export type User = Awaited<ReturnType<typeof signedInUser>>;

export async function createCommunity(page: Page, name: string) {
  await page.goto("/app");
  await page.getByRole("button", { name: "Create a community" }).first().click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
}

export async function createChannel(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Channels" }).getByRole("button", { name: "Create channel" }).click();
  await page.getByLabel("Channel name").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Create channel" }).click();
  // The redirect into a brand-new channel occasionally lands on an error boundary; the channel exists either way.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await pause(600);
  if (!(await page.getByRole("heading", { level: 1, name }).isVisible())) await page.reload();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

export async function inviteLink(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Invite people" }).click();
  await page.getByRole("button", { name: "Create invite link" }).click();
  const link = await page.getByLabel("Invite link").inputValue();
  await page.keyboard.press("Escape");
  return new URL(link).pathname;
}

export async function acceptInvite(page: Page, invitePath: string) {
  await page.goto(invitePath);
  await page.getByRole("button", { name: "Accept invite" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await waitLive(page);
}

export async function waitLive(page: Page) {
  await expect(page.locator('[data-realtime="open"]')).toBeAttached({ timeout: 10_000 });
}

/** Instant send, for seeding history before the camera rolls. */
export async function send(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: /^Message #/ });
  await composer.fill(text);
  await composer.press("Enter");
  // Emoji render as <img>, so match on the text part only.
  await expect(page.getByRole("log")).toContainText(text.replace(/[^\x00-\x7F]/g, "").trim());
}

/** Human-paced send, for the take itself. */
export async function typeAndSend(page: Page, text: string, delay = 55) {
  const composer = page.getByRole("textbox", { name: /^Message #/ });
  await composer.click();
  await composer.pressSequentially(text, { delay });
  await pause(350);
  await composer.press("Enter");
}

/** Injects a visible arrow cursor, since Playwright videos don't draw the pointer. */
// A plain string: tsx would inject a `__name` helper into a function body, which doesn't exist in the page.
const CURSOR_SCRIPT = `(() => {
  var x = -100, y = -100;
  var c = document.createElement("div");
  c.id = "demo-cursor";
  c.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;width:22px;height:22px;pointer-events:none";
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M3 2l15 7.5-6.2 1.9L9.5 18 3 2z" fill="#fff" stroke="#0f172a" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  function place() { c.style.transform = "translate(" + x + "px," + y + "px)"; }
  addEventListener("mousemove", function (e) { x = e.clientX; y = e.clientY; place(); }, true);
  // Hydration can drop foreign nodes, so keep re-attaching it.
  new MutationObserver(function () { if (document.body && !c.isConnected) document.body.appendChild(c); }).observe(document, { childList: true, subtree: true });
  place();
})();`;

export async function showCursor(page: Page) {
  await page.addInitScript(CURSOR_SCRIPT);
}

/** Glide to an element's centre in small steps, then click it. */
export async function glideClick(page: Page, target: ReturnType<Page["locator"]>) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("glideClick: target not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
  await pause(220);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export async function glideTo(page: Page, target: ReturnType<Page["locator"]>) {
  const box = await target.boundingBox();
  if (!box) throw new Error("glideTo: target not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
}

/** A community with an owner (Mara) and members, plus a few other communities for a lived-in rail. */
export async function scenario(browser: Browser, opts: { members: string[] }) {
  const owner = await signedInUser(browser, "Mara");
  {
    for (const other of ["Game Night", "Open Source", "Lo-fi Radio"]) await createCommunity(owner.page, other);
  }
  await createCommunity(owner.page, "Study Hall");
  const communityUrl = owner.page.url();
  for (const ch of ["announcements", "self-hosting", "design", "moderators"]) await createChannel(owner.page, ch);
  await owner.page.goto(communityUrl);
  const invite = await inviteLink(owner.page);
  const members: Record<string, User> = {};
  for (const name of opts.members) {
    const u = await signedInUser(browser, name);
    await acceptInvite(u.page, invite);
    members[name] = u;
  }
  return { owner, members, communityUrl, invite };
}

// ---------- recording ----------
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OUT = process.env.DEMO_OUT ?? join(process.env.HOME ?? ".", ".cache/od-demo/out");

/**
 * Records `act` as JPEG screencast frames and encodes them to H.264. Frames only arrive when the page
 * changes, so each one is held until the next arrives (concat demuxer durations).
 */
export async function record(page: Page, file: string, act: () => Promise<void>) {
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "od-frames-"));
  const frames: { path: string; t: number }[] = [];
  let seen = 0;
  await page.screencast.start({
    size: VIEWPORT,
    quality: 92,
    onFrame: ({ data, timestamp }) => {
      const path = join(dir, `${String(seen++).padStart(6, "0")}.jpg`);
      writeFileSync(path, data);
      frames.push({ path, t: timestamp });
    },
  });
  await pause(500);
  await act();
  await pause(700);
  await page.screencast.stop();
  if (frames.length < 2) throw new Error("no frames captured");
  // Timestamps are monotonic; normalise whatever unit they come in to seconds.
  const span = frames[frames.length - 1].t - frames[0].t;
  const scale = span > 1000 ? 1 / 1000 : 1;
  const list = frames.map((f, i) => {
    const next = frames[i + 1]?.t ?? f.t + 0.5 / scale;
    return `file '${f.path}'\nduration ${Math.max((next - f.t) * scale, 0.001).toFixed(4)}`;
  });
  list.push(`file '${frames[frames.length - 1].path}'`);
  const listFile = join(dir, "list.txt");
  writeFileSync(listFile, list.join("\n"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "23", "-preset", "slow", "-movflags", "+faststart", "-an", join(OUT, file)]);
  rmSync(dir, { recursive: true, force: true });
  return join(OUT, file);
}
