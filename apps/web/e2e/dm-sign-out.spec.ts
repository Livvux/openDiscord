import { expect, test, type Page } from "@playwright/test";
import { newUserPage, openAccountMenu, PASSWORD, signUp } from "./helpers";

// Explicit sign-out removes this account's encrypted-messaging device from the browser (dm-sign-out.tsx).

const userIdOf = async (page: Page) => (await page.request.get("/api/auth/get-session").then((r) => r.json())).user.id as string;
const setupCompleted = (page: Page, userId: string) => expect.poll(() => page.evaluate((id) => localStorage.getItem(`opendiscord.dm.ready:${id}`) !== null, userId), { timeout: 30_000 }).toBe(true);
const localKeys = (page: Page, userId: string) => page.evaluate((id) => [localStorage.getItem(`opendiscord.dm.device:${id}`), localStorage.getItem(`opendiscord.dm.ready:${id}`)], userId);
const dmStores = (page: Page, userId: string) => page.evaluate(async (id) => (await indexedDB.databases()).flatMap((db) => db.name ?? []).filter((name) => name.startsWith(`opendiscord-dm-${id}-`) || name.startsWith(`opendiscord-dm-history-${id}-`)).sort(), userId);

test.describe("signing out wipes local DM state", () => {
  test.skip(({ isMobile }) => isMobile, "browser storage does not depend on the layout");
  test.setTimeout(120_000);

  test("warns on the only device without a backup, then removes the device secret and stores and revokes the device", async ({ browser }) => {
    const page = await newUserPage(browser);
    const email = await signUp(page, "Wanda Wipe");
    const userId = await userIdOf(page);
    await page.goto("/app");
    await setupCompleted(page, userId);
    const deviceId = await page.evaluate((id) => JSON.parse(localStorage.getItem(`opendiscord.dm.device:${id}`)!).id as string, userId);
    const before = await dmStores(page, userId);
    expect(before).toContain(`opendiscord-dm-history-${userId}-${deviceId}`);
    expect(before.some((name) => name.startsWith(`opendiscord-dm-${userId}-${deviceId}::`))).toBe(true);

    // Cancel keeps everything.
    await openAccountMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    const dialog = page.getByRole("dialog", { name: "Sign out of this browser?" });
    await expect(dialog.getByText("This is your only device with access to encrypted messages and you have no recovery backup.")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect((await localKeys(page, userId))[0]).not.toBeNull();
    expect(await dmStores(page, userId)).toEqual(before);

    // The link opens Devices and recovery, where a backup can be created.
    await openAccountMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await dialog.getByRole("link", { name: "Go to Devices and recovery" }).click();
    await expect(page).toHaveURL(/\/app\/messages#devices-and-recovery$/);
    await expect(page.getByRole("region", { name: "Encryption settings" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Create encrypted recovery backup" })).toBeVisible();

    // Signing out anyway wipes this browser.
    await openAccountMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await dialog.getByRole("button", { name: "Sign out anyway" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(await localKeys(page, userId)).toEqual([null, null]);
    await expect.poll(() => dmStores(page, userId)).toEqual([]);

    // The device is revoked server-side: a next sign-in here is a new device.
    // Next keeps the previous route mounted but hidden, so scope to the visible form.
    const form = page.locator("form:visible");
    await form.getByLabel("Email", { exact: true }).fill(email);
    await form.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await form.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/app$/);
    const devices = (await page.request.get(`/api/dm?devices=${userId}`).then((r) => r.json())).devices as { id: string; revoked: boolean }[];
    expect(devices.find((device) => device.id === deviceId)?.revoked).toBe(true);
    await page.context().close();
  });
});
