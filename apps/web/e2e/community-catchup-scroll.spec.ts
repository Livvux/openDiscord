import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, sendMessage, signUp } from "./helpers";

test("initial catch-up preserves a scrolled-up reader and subsequent live messages stay pinned near the bottom", async ({ browser, isMobile }, testInfo) => {
  test.skip(isMobile, "desktop wheel and scroll-position regression");
  const writer = await newUserPage(browser);
  let reader: Awaited<ReturnType<typeof joinAsNewUser>> | undefined;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const errors: string[] = [];
  try {
    await signUp(writer, "Scroll Writer");
    await createCommunity(writer, "Catchup scroll");
    const channelUrl = writer.url();
    const channelId = new URL(channelUrl).pathname.split("/").at(-1)!;
    for (let index = 0; index < 3; index++) {
      await sendMessage(writer, `History ${index}: ${"A long message keeps this channel scrollable. ".repeat(60)}`.trim());
    }
    reader = await joinAsNewUser(browser, "Scroll Reader", await createInviteLink(writer));
    await reader.goto("/app");
    reader.on("pageerror", (error) => errors.push(error.message));
    reader.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    const historyPath = `/api/channels/${channelId}/messages`;
    let held = 0;
    let forwarded = 0;
    await reader.route((url) => url.pathname === historyPath && !url.searchParams.has("before"), async (route) => {
      held++;
      await gate;
      forwarded++;
      await route.continue();
    });
    await reader.goto(channelUrl);
    const log = reader.getByRole("log", { name: "Messages in #general" });
    await expect(log.getByRole("listitem")).toHaveCount(3);
    await expect(log.locator("xpath=ancestor::*[@data-realtime][1]")).toHaveAttribute("data-realtime", "open");
    await expect.poll(() => held).toBe(1);
    expect(forwarded).toBe(0);
    const scroller = log.locator("xpath=../..");
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(300);
    await scroller.hover();
    await reader.mouse.wheel(0, -100_000);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(2);
    await sendMessage(writer, "Live during initial catchup");
    await expect(log.getByText("Live during initial catchup", { exact: true })).toBeAttached();
    const response = reader.waitForResponse((response) => new URL(response.url()).pathname === historyPath && response.status() === 200);
    release();
    expect(await (await response).finished()).toBeNull();
    // Let React commit and its layout effect settle after the real response body finishes.
    await reader.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(log.getByRole("listitem")).toHaveCount(4);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(2);
    expect(forwarded).toBe(1);
    await scroller.hover();
    await reader.mouse.wheel(0, 100_000);
    const bottomGap = () => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    await expect.poll(bottomGap).toBeLessThan(2);
    await sendMessage(writer, "Live at the bottom");
    await expect(log.getByText("Live at the bottom", { exact: true })).toBeVisible();
    await expect(log.getByRole("listitem")).toHaveCount(5);
    await expect.poll(bottomGap).toBeLessThan(2);
    expect(errors).toEqual([]);
    await reader.screenshot({ path: testInfo.outputPath("community-catchup-scroll.png"), fullPage: true });
  } finally {
    release();
    await reader?.context().close();
    await writer.context().close();
  }
});
