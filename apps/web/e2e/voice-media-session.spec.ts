import { expect, test, type JSHandle, type Page, type Request, type Response } from "@playwright/test";
import { TokenVerifier } from "livekit-server-sdk";
import type { MediaHarness } from "./fixtures/voice-media-session";
import { buildVoiceMediaHarness } from "./fixtures/voice-media-build";
import { legitimateStartupConflict, observeMediaGrant, type GrantObservation, type MediaEpoch } from "./fixtures/voice-media-observer";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, signUp } from "./helpers";

type Handle = JSHandle<MediaHarness>;
function controlRequest(request: Request, origin: string): { action: string; expectedGeneration: number } | null {
  const url = new URL(request.url());
  if (request.method() !== "POST" || url.origin !== origin || url.pathname !== "/api/voice/control") return null;
  let body: unknown;
  try { body = request.postDataJSON(); } catch { return null; }
  if (!body || typeof body !== "object" || !("action" in body) || typeof body.action !== "string") return null;
  const input = "input" in body ? body.input : undefined;
  const expectedGeneration = input && typeof input === "object" && "expectedGeneration" in input && typeof input.expectedGeneration === "number" ? input.expectedGeneration : 0;
  return { action: body.action, expectedGeneration };
}
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
    type TokenRecord = { epoch: MediaEpoch; pageIndex: number; observation?: Promise<GrantObservation> };
    type RequestMeta = { startup: boolean; expectedGeneration: number; token?: TokenRecord };
    const requests = new WeakMap<Request, RequestMeta>(), tokens: TokenRecord[] = [];
    const conflicts: { method: string; path: string; action: string; status: number; startup: boolean; expectedGeneration: number }[][] = [[], [], []];
    const resource409s = [0, 0, 0], removeListeners: (() => void)[] = [];
    let epoch: MediaEpoch = "initial", startup = true, primaryFailure = false;
    const diagnostics = async () => Promise.all(handles.map(async handle => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([handle.evaluate(h => h.stats()), new Promise(resolve => { timer = setTimeout(() => resolve({ error: "diagnostic-timeout" }), 2000); })]); }
      catch { return { error: "diagnostic-unavailable" }; }
      finally { clearTimeout(timer); }
    }));
    async function grantBarrier(phase: MediaEpoch): Promise<void> {
      await expect.poll(() => tokens.filter(record => record.epoch === phase).length, { timeout: 10_000 }).toBe(3);
      await expect.poll(() => tokens.filter(record => record.epoch === phase).every(record => !!record.observation), { timeout: 10_000 }).toBe(true);
      const results = await Promise.all(tokens.filter(record => record.epoch === phase).map(record => record.observation!));
      if (results.length !== 3 || results.some(result => result.errorStage !== "none" || !result.grant)) throw new Error(`Media grant observation failed: ${JSON.stringify({ phase, results, states: await diagnostics() })}`);
      expect(results.map(result => result.pageIndex).sort()).toEqual([0, 1, 2]);
      for (const result of results) {
        if (result.pageIndex === 0) expect(result.grant).toMatchObject({ publish: true, subscribe: true, data: false });
        else expect(result.grant).toEqual({ sources: [], publish: false, subscribe: true, data: false });
      }
    }
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
        const origin = new URL(page.url()).origin;
        page.on("pageerror", error => errors.push(error.name));
        page.on("console", message => {
          if (message.type() !== "error") return;
          const location = message.location().url;
          if (startup && location && new URL(location).origin === origin && new URL(location).pathname === "/api/voice/control" && message.text() === "Failed to load resource: the server responded with a status of 409 (Conflict)") resource409s[index]++;
          else errors.push("console-error");
        });
        const onRequest = (request: Request) => {
          const input = controlRequest(request, origin); if (!input) return;
          const meta: RequestMeta = { startup, expectedGeneration: input.expectedGeneration };
          if (input.action === "token") { meta.token = { epoch, pageIndex: index }; tokens.push(meta.token); }
          requests.set(request, meta);
        };
        const onFailed = (request: Request) => {
          const token = requests.get(request)?.token;
          if (token && !token.observation) token.observation = Promise.resolve({ epoch: token.epoch, pageIndex: index, status: 0, finished: false, requestFailure: request.failure()?.errorText === "net::ERR_ABORTED" ? "aborted" : "network", errorStage: "finished" });
        };
        const onResponse = (response: Response) => {
          const path = new URL(response.url()).pathname;
          if (path.startsWith("/__voice-media-ci/") && response.ok()) assets.add(path);
          const request = response.request(), input = controlRequest(request, origin); if (!input) return;
          const meta = requests.get(request);
          if (response.status() === 409) conflicts[index].push({ method: request.method(), path, action: input.action, status: response.status(), startup: meta?.startup ?? false, expectedGeneration: meta?.expectedGeneration ?? 0 });
          if (input.action !== "token") return;
          const token = meta?.token;
          if (!token) { errors.push("untracked-token-request"); return; }
          token.observation = observeMediaGrant({ epoch: token.epoch, pageIndex: index, status: response.status(), finished: () => response.finished(), failure: () => request.failure(), read: () => response.json(), verify: async token => {
            const claims = await new TokenVerifier(process.env.LIVEKIT_API_KEY ?? "devkey", process.env.LIVEKIT_API_SECRET ?? "secret").verify(token, 0);
            return { publish: claims.video?.canPublish === true, subscribe: claims.video?.canSubscribe === true, data: claims.video?.canPublishData === true };
          } });
        };
        page.on("request", onRequest); page.on("requestfailed", onFailed); page.on("response", onResponse);
        removeListeners.push(() => { page.off("request", onRequest); page.off("requestfailed", onFailed); page.off("response", onResponse); });
        await page.context().grantPermissions(["local-network-access", "microphone", "camera"], { origin: new URL(page.url()).origin });
        await bundle.serve(page);
        handles.push(await page.evaluateHandle(async channelId => {
          // Only a static module is intercepted. Product CallSession makes every real HTTP/native operation.
          const path = "/__voice-media-ci/entry.js";
          const fixture: { open(channelId: string): Promise<MediaHarness> } = await import(path);
          return fixture.open(channelId);
        }, channelId));
      }
      for (const handle of handles) await expect.poll(() => handle.evaluate(h => h.view().roster.length), { timeout: 15_000 }).toBe(3);
      for (const handle of handles) await expect.poll(() => handle.evaluate(h => h.view().keysPrepared), { timeout: 15_000 }).toBe(true);
      for (const [index, handle] of handles.entries()) {
        const currentGeneration = await handle.evaluate(h => h.view().generation);
        expect(conflicts[index].every(conflict => legitimateStartupConflict({ ...conflict, currentGeneration }))).toBe(true);
        expect(resource409s[index]).toBe(conflicts[index].length);
      }
      startup = false;
      await verify(handles[0], handles[1]); await verify(handles[0], handles[2]); await verify(handles[1], handles[2]);
      const sorted = await Promise.all(handles.map(async handle => ({ handle, id: await handle.evaluate(h => h.view().selfMemberId) })));
      sorted.sort((a, b) => a.id.localeCompare(b.id));
      for (const { handle } of sorted.slice(1)) await handle.evaluate(h => h.confirm());
      await sorted[0].handle.evaluate(h => h.confirm());
      await grantBarrier("initial");
      for (const handle of handles) {
        await expect.poll(() => handle.evaluate(h => h.stats()), { timeout: 10_000 }).toMatchObject({ state: "agreed", ownAck: true, submitted: 3, keysBeforeOwnAck: 3 });
      }
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
      await grantBarrier("initial"); epoch = "rekey";
      await sorted[0].handle.evaluate(h => h.rekey());
      await grantBarrier("rekey");
      for (const handle of handles) await expect.poll(() => handle.evaluate(h => h.stats()), { timeout: 10_000 }).toMatchObject({ state: "agreed", workerCount: 2, ownAck: true, submitted: 3, keysBeforeOwnAck: 3, liveSources: 0 });
      for (const handle of handles.slice(1)) expect(await handle.evaluate(h => h.stats())).toMatchObject({ captureCalls: 0, sourceCalls: 0, localSenders: 0 });
      await owner.screenshot({ path: test.info().outputPath("unactivated-call-control-page.png") });
      await grantBarrier("rekey");
      expect(errors).toEqual([]);
    } catch (error) {
      primaryFailure = true;
      await test.info().attach("media-state-diagnostic.json", { contentType: "application/json", body: JSON.stringify({ epoch, states: await diagnostics(), tokenRequests: tokens.map(record => ({ epoch: record.epoch, pageIndex: record.pageIndex, observationStarted: !!record.observation })) }) });
      throw error;
    } finally {
      const observations = await Promise.all(tokens.map(record => record.observation ?? Promise.resolve({ epoch: record.epoch, pageIndex: record.pageIndex, errorStage: "missing-response" })));
      removeListeners.forEach(remove => remove());
      for (const handle of handles) { await handle.evaluate(h => h.close()).catch(() => {}); await handle.dispose(); }
      for (const page of pages) await page.context().close();
      await bundle.close();
      if (!primaryFailure) expect(observations.every(result => result.errorStage === "none")).toBe(true);
    }
  });
});
