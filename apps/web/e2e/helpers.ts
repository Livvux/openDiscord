import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { REGISTRATION_HEADER, registrationAttestation } from "../src/lib/registration-policy";
import { safeNextPath } from "../src/lib/safe-redirect";

export const PASSWORD = "correct horse battery";
let ipCounter = 0;

/**
 * A fresh browser context posing as its own client IP, so parallel sign-ups don't trip the
 * per-IP auth rate limit (production trusts X-Forwarded-For from Caddy).
 */
export async function newUserPage(browser: Browser) {
  ipCounter += 1;
  const ip = `10.${process.pid % 250}.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
  // Same device and baseURL as the running project.
  const { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
  const context = await browser.newContext({
    baseURL,
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    extraHTTPHeaders: { "X-Forwarded-For": ip },
  });
  return context.newPage();
}

/**
 * Cloudflare's documented Turnstile test token. The E2E server runs with Cloudflare's always-pass test
 * keys (playwright.config.ts), so API sign-ups send this instead of solving a challenge.
 */
export const CAPTCHA_HEADER = { "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX", [REGISTRATION_HEADER]: registrationAttestation(Number(process.env.MINIMUM_AGE ?? 16)) };

export function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

/** Signs up through the UI. Starts at `path` (e.g. an invite's sign-up link). */
export async function signUp(page: Page, name: string, path = "/sign-up") {
  const email = uniqueEmail(name.toLowerCase().replace(/\W+/g, "-"));
  await page.goto(path);
  const form = page.locator("form:visible");
  await form.getByLabel("Display name").fill(name);
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill(PASSWORD);
  await form.getByRole("checkbox", { name: /I am at least/ }).check();
  // Wait for the Turnstile widget (test key: passes without interaction) to hand out its token.
  await expect(form.locator('[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
  const signupUrl = new URL(page.url());
  const destination = new URL(safeNextPath(signupUrl.searchParams.get("next")), signupUrl.origin).href;
  const started = performance.now();
  const diagnostics: { phase: string; status: number | null; apiErrorCode: string | null; responseMs: number | null; redirectMs: number | null } = {
    phase: "auth-response", status: null, apiErrorCode: null, responseMs: null, redirectMs: null,
  };
  try {
    // Subscribe before clicking; the redirect deadline starts only after the native POST responds.
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "POST"
        && response.url() === `${signupUrl.origin}/api/auth/sign-up/email`),
      form.getByRole("button", { name: "Create account" }).click(),
    ]);
    diagnostics.status = response.status();
    if (await response.finished()) throw new Error("Sign-up POST response did not finish.");
    diagnostics.responseMs = Math.round(performance.now() - started);
    if (!response.ok()) {
      const body: unknown = await response.json().catch(() => null);
      if (body && typeof body === "object" && "code" in body && typeof body.code === "string" && /^[A-Z0-9_]{1,100}$/.test(body.code)) {
        diagnostics.apiErrorCode = body.code;
      }
      throw new Error(`Sign-up POST failed: HTTP ${response.status()} (${diagnostics.apiErrorCode ?? "unknown error code"}).`);
    }
    diagnostics.phase = "redirect";
    const responded = performance.now();
    await expect(page).toHaveURL(destination, { timeout: 5_000 });
    diagnostics.redirectMs = Math.round(performance.now() - responded);
    diagnostics.phase = "complete";
  } finally {
    // Aggregate timings/status only: never write response bodies, account data, cookies or tokens.
    await writeFile(test.info().outputPath("signup-diagnostics.json"), JSON.stringify(diagnostics));
  }
  return email;
}

export async function createCommunity(page: Page, name: string) {
  await page.goto("/app");
  await page.getByRole("button", { name: "Create a community" }).first().click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
}

export async function sendMessage(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: /^Message #/ });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByRole("log").getByText(text, { exact: true })).toBeVisible();
}

export async function createInviteLink(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Invite people" }).click();
  await page.getByRole("button", { name: "Create invite link" }).click();
  const link = await page.getByLabel("Invite link").inputValue();
  await page.keyboard.press("Escape");
  return new URL(link).pathname;
}

/** WCAG 2.2 A/AA automated checks. Automated checks catch a subset; manual review is still needed. */
export async function expectNoA11yViolations(page: Page) {
  await expect(page).toHaveTitle(/\S/);
  // Measure the settled UI: entrance animations would make contrast checks nondeterministic.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => `${n.target.join(" ")} ${n.failureSummary ?? ""}`).join(" | ")}`);
  expect(summary).toEqual([]);
}

export async function createChannel(page: Page, name: string) {
  await page.getByRole("button", { name: "Create channel" }).click();
  await page.getByLabel("Channel name").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

/** Signs up a second person and joins the community through an invite path. */
export async function joinAsNewUser(browser: Browser, name: string, invitePath: string) {
  const page = await newUserPage(browser);
  await signUp(page, name);
  await page.goto(invitePath);
  await page.getByRole("button", { name: "Accept invite" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await waitForLive(page);
  return page;
}

/** Waits until the community's realtime stream is connected, so later events can't be missed. */
export async function waitForLive(page: Page) {
  await expect(page.locator('[data-realtime="open"]')).toBeAttached({ timeout: 10_000 });
}

/** The account popover at the bottom of the community rail (an off-canvas panel on mobile). */
export async function openAccountMenu(page: Page) {
  const nav = page.getByRole("navigation", { name: "Communities" });
  const openNavigation = page.getByRole("button", { name: "Open navigation" }).first();
  // Redirect URLs can settle before the streamed app shell mounts. Absence is not a mobile layout.
  await expect.poll(async () => (await nav.isVisible()) || (await openNavigation.isVisible())).toBe(true);
  if (!(await nav.isVisible())) await openNavigation.click();
  await nav.getByRole("button", { name: /^Account menu for / }).click();
}

export async function openAccountSettings(page: Page) {
  await openAccountMenu(page);
  await page.getByRole("link", { name: "Account settings" }).click();
  await expect(page).toHaveURL(/\/app\/settings$/);
}
