import { expect, test, type JSHandle, type Page } from "@playwright/test";
import { TokenVerifier } from "livekit-server-sdk";
import type { MediaHarness } from "./fixtures/voice-media-session";
import { buildVoiceMediaHarness } from "./fixtures/voice-media-build";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, signUp } from "./helpers";

type Handle = JSHandle<MediaHarness>;
async function verify(a: Handle, b: Handle) {
  const aId = await a.evaluate(h => h.view().selfMemberId), bId = await b.evaluate(h => h.view().selfMemberId);
  const [first, second, firstId, secondId] = aId < bId ? [a, b, aId, bId] as const : [b, a, bId, aId] as const;
  await first.evaluate((h, id) => h.request(id), secondId);
  await expect.poll(() => second.evaluate((h, id) => h.view().sas.some(s => s.peer.memberId === id), firstId)).toBe(true);
  const remote = await second.evaluate((h, id) => h.view().sas.find(s => s.peer.memberId === id)!.handle, firstId);
  await second.evaluate((h, handle) => h.step(handle, "accept"), remote);
  await expect.poll(() => first.evaluate((h, id) => h.view().sas.some(s => s.peer.memberId === id && s.ready), secondId)).toBe(true);
  const local = await first.evaluate((h, id) => h.view().sas.find(s => s.peer.memberId === id)!.handle, secondId);
  await first.evaluate((h, handle) => h.step(handle, "start"), local);
  // Request.ready predates SAS start. Allow the same one-poll delivery window
  // as the accepted native integration fixture before accepting real SAS.
  await second.evaluate(() => new Promise(resolve => setTimeout(resolve, 1_200)));
  await second.evaluate((h, handle) => h.step(handle, "accept-sas"), remote);
  await expect.poll(() => first.evaluate((h, handle) => h.view().sas.find(s => s.handle === handle)?.emojiIndices?.length ?? 0, local)).toBe(7);
  const lhs = await first.evaluate((h, handle) => h.view().sas.find(s => s.handle === handle)!.emojiIndices, local);
  await expect.poll(() => second.evaluate((h, handle) => h.view().sas.find(s => s.handle === handle)?.emojiIndices ?? null, remote)).toEqual(lhs);
  await first.evaluate((h, handle) => h.step(handle, "confirm"), local);
  await second.evaluate((h, handle) => h.step(handle, "confirm"), remote);
  await expect.poll(() => first.evaluate((h, handle) => h.view().sas.some(s => s.handle === handle && s.done), local)).toBe(true);
  await expect.poll(() => second.evaluate((h, handle) => h.view().sas.some(s => s.handle === handle && s.done), remote)).toBe(true);
  await first.evaluate((h, id) => h.admit(id), secondId); await second.evaluate((h, id) => h.admit(id), firstId);
}

test.describe("unactivated production MediaSession real cookie/native/SFU listener acceptance", () => {
  test.skip(({ isMobile }) => isMobile, "Controlled Chromium source capability gate; product mobile UI remains separate.");
  test("three real admitted accounts include two listen-only grants with genuine worker ACK, zero capture and Opus/VP8 decode", async ({ browser }) => {
    test.setTimeout(180_000);
    const bundle = await buildVoiceMediaHarness();
    const pages: Page[] = [], handles: Handle[] = [];
    const errors: string[] = [], assets = new Set<string>();
    const grants: { sources: string[]; publish: boolean; subscribe: boolean; data: boolean }[][] = [[], [], []];
    const tokenObservations: Promise<void>[] = [];
    try {
      const owner = await newUserPage(browser); pages.push(owner);
      await signUp(owner, "Media Publisher"); await createCommunity(owner, "Actual MediaSession listener");
      const invite = await createInviteLink(owner);
      await owner.getByRole("button", { name: "Create channel", exact: true }).click();
      await owner.getByLabel("Channel name").fill("actual-media"); await owner.getByRole("radio", { name: /Voice/ }).check();
      await owner.getByRole("dialog").getByRole("button", { name: "Create channel" }).click();
      await expect(owner.getByRole("heading", { level: 2, name: "actual-media" })).toBeVisible();
      const url = owner.url(), channelId = new URL(url).pathname.split("/").at(-1)!;
      await owner.getByRole("button", { name: "Channel settings" }).click();
      await owner.getByRole("dialog").getByLabel("Speak for everyone").selectOption("deny");
      await expect(owner.getByRole("dialog").getByLabel("Speak for everyone")).toHaveValue("deny");
      await owner.getByRole("dialog").getByLabel("Video for everyone").selectOption("deny");
      await expect(owner.getByRole("dialog").getByLabel("Video for everyone")).toHaveValue("deny");
      await owner.keyboard.press("Escape");
      for (const name of ["Media Listener One", "Media Listener Two"]) {
        const page = await joinAsNewUser(browser, name, invite); pages.push(page); await page.goto(url);
        await expect(page.getByRole("heading", { level: 2, name: "actual-media" })).toBeVisible();
      }
      for (const [index, page] of pages.entries()) {
        page.on("pageerror", error => errors.push(error.name));
        page.on("console", message => { if (message.type() === "error") errors.push("console-error"); });
        page.on("response", response => {
          const path = new URL(response.url()).pathname;
          if (path.startsWith("/__voice-media-ci/") && response.ok()) assets.add(path);
          if (path !== "/api/voice/control" || response.request().method() !== "POST") return;
          const request: unknown = response.request().postDataJSON();
          if (!request || typeof request !== "object" || !("action" in request) || request.action !== "token") return;
          tokenObservations.push((async () => {
            if (!response.ok()) throw new Error("Actual media token request failed.");
            const grant: { sources: string[]; token: string } = await response.json();
            const claims = await new TokenVerifier(process.env.LIVEKIT_API_KEY ?? "devkey", process.env.LIVEKIT_API_SECRET ?? "secret").verify(grant.token, 0);
            grants[index].push({ sources: grant.sources, publish: claims.video?.canPublish === true, subscribe: claims.video?.canSubscribe === true, data: claims.video?.canPublishData === true });
          })());
        });
        await page.context().grantPermissions(["local-network-access", "microphone", "camera"], { origin: new URL(page.url()).origin });
        await bundle.serve(page);
        handles.push(await page.evaluateHandle(async channelId => {
          // Only a static module is intercepted. Product CallSession makes every real HTTP/native operation.
          const path = "/__voice-media-ci/entry.js";
          const module: { open(channelId: string): Promise<MediaHarness> } = await import(path);
          return module.open(channelId);
        }, channelId));
      }
      for (const handle of handles) await expect.poll(() => handle.evaluate(h => h.view().roster.length), { timeout: 15_000 }).toBe(3);
      for (const handle of handles) await expect.poll(() => handle.evaluate(h => h.view().keysPrepared), { timeout: 15_000 }).toBe(true);
      await verify(handles[0], handles[1]); await verify(handles[0], handles[2]); await verify(handles[1], handles[2]);
      const sorted = await Promise.all(handles.map(async handle => ({ handle, id: await handle.evaluate(h => h.view().selfMemberId) })));
      sorted.sort((a, b) => a.id.localeCompare(b.id));
      for (const { handle } of sorted.slice(1)) await handle.evaluate(h => h.confirm());
      await sorted[0].handle.evaluate(h => h.confirm());
      for (const handle of handles) {
        await expect.poll(() => handle.evaluate(h => h.stats()), { timeout: 10_000 }).toMatchObject({ state: "agreed", ownAck: true, submitted: 3, keysBeforeOwnAck: 3 });
      }
      await Promise.all(tokenObservations);
      expect(grants[0][0]).toMatchObject({ publish: true, subscribe: true, data: false });
      for (const index of [1, 2]) expect(grants[index][0]).toEqual({ sources: [], publish: false, subscribe: true, data: false });
      // Real deliberate intent methods, never automatic capture from service grants.
      await owner.getByRole("heading", { level: 2, name: "actual-media" }).click();
      await expect(async () => handles[0].evaluate(h => h.microphone(true))).toPass({ timeout: 8_000 });
      await handles[0].evaluate(h => h.camera(true));
      for (const handle of handles.slice(1)) {
        await expect.poll(() => handle.evaluate(async h => { const stats = await h.stats(); return stats.audioEnergy > 0 && stats.videoFrames > 10 && stats.width > 0 && stats.codecs.includes("audio/opus") && stats.codecs.includes("video/VP8"); }), { timeout: 15_000 }).toBe(true);
        expect(await handle.evaluate(h => h.stats())).toMatchObject({ captureCalls: 0, sourceCalls: 0, localSenders: 0, liveSources: 0, ownAck: true, keysBeforeOwnAck: 3 });
      }
      expect([...assets].some(path => path.endsWith(".wasm"))).toBe(true); expect([...assets].some(path => path.includes("e2ee") && path.endsWith(".mjs"))).toBe(true);
      // Fresh actual proposal/worker; prior listener ACK cannot become new readiness.
      await sorted[0].handle.evaluate(h => h.rekey());
      for (const handle of handles) await expect.poll(() => handle.evaluate(h => h.stats()), { timeout: 10_000 }).toMatchObject({ state: "agreed", workerCount: 2, ownAck: true, submitted: 3, keysBeforeOwnAck: 3, liveSources: 0 });
      for (const handle of handles.slice(1)) expect(await handle.evaluate(h => h.stats())).toMatchObject({ captureCalls: 0, sourceCalls: 0, localSenders: 0 });
      await owner.screenshot({ path: test.info().outputPath("unactivated-call-control-page.png") });
      expect(errors).toEqual([]);
    } finally {
      for (const handle of handles) { await handle.evaluate(h => h.close()).catch(() => {}); await handle.dispose(); }
      for (const page of pages) await page.context().close();
      await bundle.close();
    }
  });
});
