import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

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
  await form.getByRole("button", { name: "Create account" }).click();
  // Signed in once the app (or the `next` target) has loaded.
  await expect(page).not.toHaveURL(/\/sign-up/);
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
  // Measure the settled UI: entrance animations would make contrast checks nondeterministic.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => `${n.target.join(" ")} ${n.failureSummary ?? ""}`).join(" | ")}`);
  expect(summary).toEqual([]);
}
