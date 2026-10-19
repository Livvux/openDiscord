import { expect, test, type Page } from "@playwright/test";
import { createCommunity, newUserPage, signUp } from "./helpers";

type Icon = { src: string; sizes: string; type: string; purpose?: string };

/** Width and height from the PNG IHDR chunk. */
function pngSize(png: Buffer) {
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

async function headContent(page: Page, selector: string, attribute: string) {
  return page.locator(`head ${selector}`).first().getAttribute(attribute);
}

test.describe("installable web app", () => {
  test("the manifest describes a standalone app with real any and maskable icons", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("application/manifest+json");
    const manifest = await response.json();
    expect(manifest).toMatchObject({
      name: "openDiscord",
      short_name: "openDiscord",
      id: "/app",
      start_url: "/app",
      scope: "/",
      display: "standalone",
      theme_color: "#0f172a",
      background_color: "#0f172a",
    });
    const icons: Icon[] = manifest.icons;
    for (const icon of icons) {
      const file = await request.get(icon.src);
      expect(file.ok(), icon.src).toBe(true);
      expect(file.headers()["content-type"]).toBe(icon.type);
      expect(pngSize(await file.body())).toBe(icon.sizes);
    }
    const purposes = icons.map((icon) => `${icon.purpose ?? "any"} ${icon.sizes}`);
    expect(purposes).toEqual(expect.arrayContaining(["any 192x192", "any 512x512", "maskable 512x512"]));
    expect(manifest.shortcuts.length).toBeGreaterThan(0);
    for (const shortcut of manifest.shortcuts) expect(shortcut.url).toMatch(/^\/app(\/|$)/);
  });

  test("pages link the manifest and carry the iOS home-screen tags", async ({ page }) => {
    await page.goto("/sign-in");
    expect(await headContent(page, 'link[rel="manifest"]', "href")).toBe("/manifest.webmanifest");
    expect(await headContent(page, 'link[rel="apple-touch-icon"]', "href")).toMatch(/^\/apple-icon\.png/);
    expect(await headContent(page, 'meta[name="apple-mobile-web-app-capable"]', "content")).toBe("yes");
    expect(await headContent(page, 'meta[name="apple-mobile-web-app-title"]', "content")).toBe("openDiscord");
    const touchIcon = await page.request.get((await headContent(page, 'link[rel="apple-touch-icon"]', "href"))!);
    expect(pngSize(await touchIcon.body())).toBe("180x180");
  });

  test("Chromium reports the site as installable", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "installability audit is a Chromium DevTools API");
    await page.goto("/sign-in");
    const cdp = await page.context().newCDPSession(page);
    await expect
      .poll(async () => (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors.map((e) => e.errorId))
      .toEqual([]);
  });

  test("touch devices get a composer iOS won't zoom into", async ({ browser, isMobile }) => {
    test.skip(!isMobile, "touch layout");
    const page = await newUserPage(browser);
    await signUp(page, "Zoe Zoom");
    await createCommunity(page, "Zoom Club");
    const composer = page.getByRole("textbox", { name: /^Message #/ });
    expect(parseFloat(await composer.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    await page.context().close();
  });

  test("the app shell respects safe areas and falls back to an offline page without caching app data", async ({ browser, browserName }) => {
    const page = await newUserPage(browser);
    await signUp(page, "Sam Standalone");
    await page.goto("/app");
    expect(await headContent(page, 'meta[name="viewport"]', "content")).toContain("viewport-fit=cover");
    expect(await headContent(page, 'meta[name="theme-color"]', "content")).toBe("#0f172a");

    const shell = page.locator("[data-app-shell]");
    await expect(shell).toBeVisible();
    if (browserName === "chromium") {
      // A notched phone in portrait: content must stay clear of the status bar and home indicator.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
      await expect.poll(() => shell.evaluate((el) => [getComputedStyle(el).paddingTop, getComputedStyle(el).paddingBottom])).toEqual(["47px", "34px"]);
      const navigation = page.getByRole("button", { name: "Open navigation" }).first();
      if (await navigation.isVisible()) {
        await navigation.click();
        const panel = page.getByRole("navigation", { name: "Communities" });
        await expect.poll(() => panel.evaluate((el) => getComputedStyle(el).paddingTop)).toBe("47px");
        await page.keyboard.press("Escape");
      }
    }

    await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration("/"))?.active)).toBe(true);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.context().setOffline(true);
    try {
      await page.goto("/app/settings");
      await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
    } finally {
      await page.context().setOffline(false);
    }
    // Only the static offline page may be stored; never authenticated pages, API responses or DMs.
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const key of await caches.keys()) {
        for (const request of await (await caches.open(key)).keys()) urls.push(new URL(request.url).pathname);
      }
      return urls;
    });
    expect(cached).toEqual(["/offline.html"]);
    await page.goto("/app");
    await expect(shell).toBeVisible();
    await page.context().close();
  });
});
