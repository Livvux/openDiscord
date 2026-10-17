import { writeFile } from "node:fs/promises";
import { expect, test, type Locator } from "@playwright/test";
import { z } from "zod";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, sendMessage, signUp } from "./helpers";

const phases = ["before-wheel", "native-scroll", "post-scroll-RAF1", "post-scroll-RAF2", "before-final-send",
  "first-final-message-observed", "post-message-RAF1", "post-message-RAF2", "resize", "final-success-or-failure"] as const;
const nonnegative = z.number().finite().nonnegative();
const ledgerSchema = z.object({
  available: z.literal(true), finalSucceeded: z.boolean(), postMessageFrames: nonnegative.max(2), postMessageDeadlineExpired: z.boolean(),
  samples: z.array(z.object({
    phase: z.enum(phases), elapsedMs: nonnegative, scrollTop: nonnegative, scrollHeight: nonnegative,
    clientHeight: nonnegative, bottomGap: nonnegative, scrollEvents: nonnegative, resizeEvents: nonnegative,
    unavailable: z.boolean(), overscrolled: z.boolean(),
  }).strict()).max(64),
}).strict();
type ScrollSample = z.infer<typeof ledgerSchema>["samples"][number];

async function installScrollProbe(scroller: Locator) {
  return scroller.evaluateHandle((element) => {
    const started = performance.now();
    const samples: ScrollSample[] = [];
    const frames = new Set<number>();
    let stopped = false;
    let scrollEvents = 0;
    let resizeEvents = 0;
    let wheelStartCount = 0;
    let acknowledgedScroll = 0;
    let scrollFrame: number | null = null;
    let postMessageFrames = 0;
    let postMessageDeadlineExpired = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let completeObservation: (() => void) | undefined;
    const rawGap = () => element.scrollHeight - element.clientHeight - element.scrollTop;
    const sample = (phase: ScrollSample["phase"]) => {
      if (stopped || (samples.length >= 63 && phase !== "final-success-or-failure")) return;
      const values = [performance.now() - started, element.scrollTop, element.scrollHeight, element.clientHeight, rawGap()];
      const unavailable = values.some((value) => !Number.isFinite(value));
      const numeric = values.map((value) => Number.isFinite(value) ? Math.max(0, value) : 0);
      samples.push({ phase, elapsedMs: numeric[0], scrollTop: numeric[1], scrollHeight: numeric[2], clientHeight: numeric[3],
        bottomGap: numeric[4], scrollEvents, resizeEvents, unavailable, overscrolled: values[1] < 0 || values[4] < 0 });
    };
    const frame = (callback: () => void) => {
      const id = requestAnimationFrame(() => { frames.delete(id); if (!stopped) callback(); });
      frames.add(id);
      return id;
    };
    const onScroll = () => {
      if (stopped) return;
      scrollEvents++;
      const eventCount = scrollEvents;
      sample("native-scroll");
      if (scrollFrame !== null) { cancelAnimationFrame(scrollFrame); frames.delete(scrollFrame); }
      scrollFrame = frame(() => {
        sample("post-scroll-RAF1");
        scrollFrame = frame(() => {
          acknowledgedScroll = eventCount;
          scrollFrame = null;
          sample("post-scroll-RAF2");
        });
      });
    };
    const resize = new ResizeObserver(() => { if (!stopped) { resizeEvents++; sample("resize"); } });
    element.addEventListener("scroll", onScroll, { passive: true });
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    const stop = () => {
      if (stopped) return;
      sample("final-success-or-failure");
      stopped = true;
      element.removeEventListener("scroll", onScroll);
      resize.disconnect();
      for (const id of frames) cancelAnimationFrame(id);
      frames.clear();
      clearTimeout(deadline);
      completeObservation?.();
    };
    const ready = () => !stopped && scrollEvents > wheelStartCount && acknowledgedScroll === scrollEvents
      && Number.isFinite(rawGap()) && rawGap() < 2;
    return {
      beforeWheel() { wheelStartCount = scrollEvents; sample("before-wheel"); },
      ready,
      beforeFinalSend() { sample("before-final-send"); return ready(); },
      messageObserved() {
        if (stopped) return Promise.resolve();
        sample("first-final-message-observed");
        return new Promise<void>((resolve) => {
          completeObservation = resolve;
          // A deadline bounds measurement; it does not wait for geometry to become successful.
          deadline = setTimeout(() => { postMessageDeadlineExpired = true; stop(); }, 1_000);
          frame(() => {
            postMessageFrames = 1;
            sample("post-message-RAF1");
            frame(() => { postMessageFrames = 2; sample("post-message-RAF2"); stop(); });
          });
        });
      },
      finish(finalSucceeded: boolean) {
        stop();
        return { available: true as const, finalSucceeded, postMessageFrames, postMessageDeadlineExpired, samples };
      },
    };
  });
}

test("initial catch-up preserves a scrolled-up reader and subsequent live messages stay pinned near the bottom", async ({ browser, isMobile }, testInfo) => {
  test.skip(isMobile, "desktop wheel and scroll-position regression");
  const writer = await newUserPage(browser);
  let reader: Awaited<ReturnType<typeof joinAsNewUser>> | undefined;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const errors: string[] = [];
  let probe: Awaited<ReturnType<typeof installScrollProbe>> | undefined;
  let finalSucceeded = false;
  try {
    await signUp(writer, "Scroll Writer");
    await createCommunity(writer, "Catchup scroll");
    const channelUrl = writer.url();
    const channelId = new URL(channelUrl).pathname.split("/").at(-1)!;
    for (let index = 0; index < 3; index++) {
      await sendMessage(writer, `History ${index}: ${"A long message keeps this channel scrollable. ".repeat(60)}`.trim());
    }
    reader = await joinAsNewUser(browser, "Scroll Reader", await createInviteLink(writer));
    // Retire the joined document and its in-flight catch-up before intercepting the fresh mount.
    // Otherwise a late request from the old document can consume the single-request gate.
    await reader.goto("about:blank");
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
    const scrollProbe = await installScrollProbe(scroller);
    probe = scrollProbe;
    await scroller.hover();
    await scrollProbe.evaluate((probe) => probe.beforeWheel());
    await reader.mouse.wheel(0, 100_000);
    const bottomGap = () => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    await expect.poll(bottomGap).toBeLessThan(2);
    // Observe genuine dispatch plus two render opportunities; this does not read React's private ref.
    await expect.poll(() => scrollProbe.evaluate((probe) => probe.ready())).toBe(true);
    expect(await scrollProbe.evaluate((probe) => probe.beforeFinalSend())).toBe(true);
    await sendMessage(writer, "Live at the bottom");
    await expect(log.getByText("Live at the bottom", { exact: true })).toBeVisible();
    await scrollProbe.evaluate((probe) => probe.messageObserved());
    await expect(log.getByRole("listitem")).toHaveCount(5);
    await expect.poll(bottomGap).toBeLessThan(2);
    expect(errors).toEqual([]);
    await reader.screenshot({ path: testInfo.outputPath("community-catchup-scroll.png"), fullPage: true });
    finalSucceeded = true;
  } finally {
    release();
    const rawLedger: unknown = await probe?.evaluate((probe, success) => probe.finish(success), finalSucceeded).catch(() => null);
    await probe?.dispose().catch(() => {});
    const parsed = ledgerSchema.safeParse(rawLedger);
    const ledger = parsed.success ? parsed.data : { available: false, finalSucceeded, samples: [] };
    try {
      await writeFile(testInfo.outputPath("community-scroll-diagnostic.json"), JSON.stringify(ledger));
    } catch (error) {
      if (finalSucceeded) throw error;
    }
    await reader?.context().close();
    await writer.context().close();
  }
});
