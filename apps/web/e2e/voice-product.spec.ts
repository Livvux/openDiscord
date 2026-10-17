import { expect, test, type Locator, type Page, type Request, type Response } from "@playwright/test";
import { TokenVerifier } from "livekit-server-sdk";
import { classifyVoiceProductConsole, fingerprintVoiceProductConsole, readVoiceProductConsoleArgument, observeVoiceProductResult, readVoiceProductPresentation, withVoiceProductCleanup, writeVoiceProductEvidence, type VoiceProductCheckpoint, type VoiceProductObservation, type VoiceProductObservationStage, type VoiceProductPhase } from "./fixtures/voice-product-results";
import { readVoiceRequestCandidates, voiceRequestCandidate } from "./fixtures/voice-product-candidates";
import { installVoiceProductObserver } from "./fixtures/voice-product-observer";
import { assertDisposableVoiceCi, strings } from "./fixtures/voice-media-observer";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, signUp } from "./helpers";

const participant = (page: Page, name: string) => page.getByRole("listitem", { name: `Voice participant ${name}`, exact: true });
const audience = (page: Page) => page.getByRole("region", { name: "Full Voice audience", exact: true });
const audienceConsent = (page: Page) => audience(page).getByRole("button", { name: "Allow this audience and prepare encrypted media" });
const presentation = (page: Page) => page.locator('[role="status"], [role="alert"]').evaluateAll(readVoiceProductPresentation);
async function publicPhase(page: Page, phase: VoiceProductPhase | readonly VoiceProductPhase[]) {
  // The existing readiness assertion budget covers the real ten-second attempt expiry too.
  let observationFailed = false;
  await expect.poll(async () => {
    const result = await observeVoiceProductResult(() => presentation(page), { timeoutMs: 2000, stage: "diagnostic" });
    if (!result.ok) observationFailed = true;
    return result.ok && (typeof phase === "string" ? result.value.phase === phase : phase.includes(result.value.phase));
  }, { timeout: 20_000 }).toBe(true);
  expect(observationFailed).toBe(false);
}
const evidence = async (page: Page) => {
  const result = await observeVoiceProductResult(() => page.evaluate(() => window.__voiceProductEvidence.snapshot()), { timeoutMs: 2000, stage: "diagnostic" });
  if (!result.ok) throw new Error(`Voice product diagnostic ${result.reason}.`);
  return result.value;
};
async function explicitJoin(page: Page) {
  await page.getByRole("button", { name: "Join voice", exact: true }).click();
  await expect(page.getByRole("region", { name: "Voice join consent" })).toBeVisible();
  await page.getByRole("button", { name: "Create temporary device and join" }).click();
  await expect(audience(page)).toBeVisible({ timeout: 20_000 });
}
type RequestSelection = Awaited<ReturnType<typeof readVoiceRequestCandidates>>;
async function verifyPair(a: Page, aName: string, b: Page, bName: string, record: (selection: RequestSelection) => void) {
  const aPeer = participant(a, bName), bPeer = participant(b, aName);
  const aRequest = aPeer.getByRole("button", { name: "Request Voice verification", exact: true });
  const bRequest = bPeer.getByRole("button", { name: "Request Voice verification", exact: true });
  const observed: { current?: RequestSelection } = {};
  await expect.poll(async () => {
    const selection = await readVoiceRequestCandidates(() => aRequest.evaluateAll(voiceRequestCandidate), () => bRequest.evaluateAll(voiceRequestCandidate));
    observed.current = selection; record(selection);
    return selection.side !== null;
  }).toBe(true);
  const selected = observed.current;
  if (!selected || selected.side === null) throw new Error("No unique eligible Voice verification action.");
  const [first, second] = selected.side === 0 ? [aPeer, bPeer] : [bPeer, aPeer];
  await first.getByRole("button", { name: "Request Voice verification" }).click();
  await second.getByRole("button", { name: "Accept Voice verification" }).click();
  await first.getByRole("button", { name: "Start SAS comparison" }).click();
  await second.getByRole("button", { name: "Accept SAS comparison" }).click();
  const compare = async (peer: Locator) => peer.getByRole("list", { name: "Voice SAS symbols" }).locator("li").allTextContents();
  await expect(first.getByRole("list", { name: "Voice SAS symbols" }).locator("li")).toHaveCount(7);
  // Do not log SAS values, even on mismatch; only genuine visible UI values are read.
  const lhs = await compare(first);
  await expect.poll(async () => JSON.stringify(await compare(second)) === JSON.stringify(lhs)).toBe(true);
  await first.getByRole("button", { name: "I compared all seven symbols — they match" }).click();
  await second.getByRole("button", { name: "I compared all seven symbols — they match" }).click();
  await first.getByRole("button", { name: "Admit this verified participant" }).click();
  await second.getByRole("button", { name: "Admit this verified participant" }).click();
  await expect(first).toContainText("Admitted for this exact device.");
  await expect(second).toContainText("Admitted for this exact device.");
}
async function consentToAudience(pages: Page[]) {
  // Genuine UI clicks, each with its own complete canonical audience rendered.
  await Promise.all(pages.map(page => audienceConsent(page).click()));
}
async function ready(page: Page) {
  await expect(page.getByRole("status").filter({ hasText: "Encrypted voice ready — microphone off" }).first()).toBeVisible({ timeout: 20_000 });
}
async function videoFingerprint(page: Page) {
  return page.getByRole("region", { name: "Video" }).locator("video").first().evaluate((video: HTMLVideoElement) => {
    if (!video.videoWidth || video.readyState < 2) return "";
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 18;
    const context = canvas.getContext("2d"); if (!context) return "";
    context.drawImage(video, 0, 0, 32, 18);
    const pixels = context.getImageData(0, 0, 32, 18).data;
    let hash = 2166136261; for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
    return String(hash >>> 0);
  });
}

test.describe("genuine Next product encrypted Voice", () => {
  test.describe.configure({ retries: 0 });
  test.skip(({ isMobile }) => isMobile, "Three separate desktop contexts; responsive behavior is checked explicitly after agreement.");
  test("three UI accounts verify/admit/consent, listeners decode Opus and moving VP8 beyond join JWT expiry", async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    assertDisposableVoiceCi({ ci: process.env.CI, githubActions: process.env.GITHUB_ACTIONS, apiKey: process.env.LIVEKIT_API_KEY, apiSecret: process.env.LIVEKIT_API_SECRET, url: process.env.LIVEKIT_URL, authUrl: process.env.BETTER_AUTH_URL });
    const verifier = new TokenVerifier("devkey", "secret");
    const pages: Page[] = [], names = ["UI Voice Publisher", "UI Voice Listener One", "UI Voice Listener Two"];
    const runtimeErrors: string[] = [];
    const consoleErrors: (ReturnType<typeof classifyVoiceProductConsole> & { page: number; revoking: boolean; observed: "pending" | "ok" | "failed"; fingerprint?: string; transport: ReturnType<typeof readVoiceProductConsoleArgument>[] })[] = [];
    const consoleObservations: Promise<void>[] = [];
    let revocationDenials = 0;
    const workerResponses: { page: number; status: number; javascript: boolean }[] = [];
    const grants: { page: number; sources: string[]; publish: boolean; subscribe: boolean; expiry: number }[] = [];
    const observation: Promise<void>[] = [];
    const memberIds = new Map<Page, string>();
    let observationFailed = false, observing = true, commitsClosed = false, primaryFailure = false;
    const stopResponseObservers: (() => void)[] = [];
    const observationFailures: { page: number; action: "join" | "token"; stage: VoiceProductObservationStage; reason: "timeout" | "failed"; status?: number; bodyError?: string }[] = [];
    const pairCandidates: RequestSelection[] = [];
    const phaseCheckpoints: Partial<Record<VoiceProductCheckpoint, VoiceProductObservation<Awaited<ReturnType<typeof presentation>>>[]>> = {};
    let leaderRetryDispatched = false;
    const checkpoint = async (name: VoiceProductCheckpoint) => {
      const results = await Promise.all(pages.map(page => observeVoiceProductResult(() => presentation(page), { timeoutMs: 2000, stage: "diagnostic" })));
      phaseCheckpoints[name] = results;
      if (results.some(result => !result.ok)) observationFailed = true;
      expect(results.every(result => result.ok)).toBe(true);
    };
    let stage = "signup";
    const attach = async (page: Page, index: number) => {
      await page.addInitScript(installVoiceProductObserver);
      await page.context().grantPermissions(["microphone", "camera"]);
      page.on("pageerror", error => runtimeErrors.push(error.name));
      page.on("console", message => {
        if (message.type() !== "error") return;
        // A genuine generation transition can return409; detailed lower-layer conflict gates remain authoritative.
        if (message.text() === "Failed to load resource: the server responded with a status of 409 (Conflict)" && new URL(message.location().url || page.url()).pathname === "/api/voice/control") return;
        const diagnostic = classifyVoiceProductConsole(message.text(), message.location().url, page.url());
        // This test deliberately revokes Connect; the authenticated control endpoint must deny it.
        if (stage === "connect-revocation" && diagnostic.kind === "http-resource" && diagnostic.status === 403 && diagnostic.endpoint === "voice-control") { revocationDenials++; return; }
        const entry: (typeof consoleErrors)[number] = { page: index, revoking: stage === "connect-revocation", observed: "pending", transport: [], ...diagnostic, ...(diagnostic.code === "other" && diagnostic.kind === "other" ? { fingerprint: fingerprintVoiceProductConsole(message.text()) } : {}) };
        consoleErrors.push(entry);
        const observation = observeVoiceProductResult(() => Promise.all(message.args().slice(0, 3).map(argument => argument.evaluate(readVoiceProductConsoleArgument))), { timeoutMs: 2000, stage: "diagnostic" });
        consoleObservations.push(observation.then(result => {
          entry.observed = result.ok ? "ok" : "failed";
          if (result.ok) entry.transport.push(...result.value);
        }));
      });
      const controlBodies = new WeakMap<Request, Promise<unknown>>();
      await page.route("**/api/voice/control", async route => {
        const request = route.request();
        const body: unknown = request.method() === "POST" ? request.postDataJSON() : null;
        if (!body || typeof body !== "object" || !("action" in body) || (body.action !== "token" && body.action !== "join")) {
          await route.continue(); return;
        }
        // Forward this request once and deliver the actual server response unchanged. Keep
        // its body in the test runner so Chromium cannot evict it before acceptance checks.
        const upstream = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
        const captured: Promise<unknown> = upstream.json();
        controlBodies.set(request, captured);
        void captured.catch(() => {});
        await route.fulfill({ response: upstream });
      });
      const onResponse = (response: Response) => {
        if (!observing) return;
        const request = response.request();
        if (request.resourceType() === "script" && /e2ee|worker/i.test(new URL(response.url()).pathname)) workerResponses.push({ page: index, status: response.status(), javascript: /javascript|ecmascript/.test(response.headers()["content-type"] ?? "") });
        if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/voice/control") return;
        const body: unknown = request.postDataJSON();
        if (!body || typeof body !== "object" || !("action" in body)) return;
        if (body.action === "join") {
          const work = observeVoiceProductResult(async checkpoint => {
            if (response.status() !== 200) throw new Error("Product join response failed.");
            const captured = controlBodies.get(request);
            if (!captured) throw new Error("Missing original product join response.");
            const snapshot: unknown = await captured; checkpoint("result");
            if (!snapshot || typeof snapshot !== "object" || !("memberId" in snapshot) || typeof snapshot.memberId !== "string") throw new Error("Missing canonical product member.");
            return snapshot.memberId;
          }).then(result => {
            if (!result.ok) { observationFailed = true; observationFailures.push({ page: index, action: "join", stage: result.stage, reason: result.reason }); }
            else if (!commitsClosed) memberIds.set(page, result.value);
          });
          observation.push(work); return;
        }
        if (body.action !== "token") return;
        let bodyError = "";
        const work = observeVoiceProductResult(async checkpoint => {
          if (response.status() !== 200) throw new Error("Product token grant failed.");
          const captured = controlBodies.get(request);
          if (!captured) throw new Error("Missing original product token response.");
          const raw = await captured.catch(error => { bodyError = "unreadable-token-response"; throw error; }); checkpoint("verify");
          if (!raw || typeof raw !== "object" || !("token" in raw) || typeof raw.token !== "string" || !("sources" in raw) || !strings(raw.sources) || !("participantIdentity" in raw) || !("roomName" in raw)) throw new Error("Invalid product token response.");
          const claims = await verifier.verify(raw.token, 0); checkpoint("result");
          const sources: unknown = claims.video?.canPublishSources ?? [];
          if (claims.sub !== raw.participantIdentity || claims.video?.room !== raw.roomName || !strings(sources) || JSON.stringify(sources) !== JSON.stringify(raw.sources) || typeof claims.exp !== "number") throw new Error("Actual product grant binding mismatch.");
          return Object.freeze({ page: index, sources: [...sources], publish: claims.video?.canPublish === true, subscribe: claims.video?.canSubscribe === true, expiry: claims.exp * 1000 });
        }).then(result => {
          if (!result.ok) { observationFailed = true; observationFailures.push({ page: index, action: "token", stage: result.stage, reason: result.reason, status: response.status(), bodyError }); }
          else if (!commitsClosed) grants.push(result.value);
        });
        observation.push(work);
      };
      page.on("response", onResponse); stopResponseObservers.push(() => page.off("response", onResponse));
    };
    try {
      const owner = await newUserPage(browser); pages.push(owner); await attach(owner, 0);
      await signUp(owner, names[0]); await createCommunity(owner, "Next product encrypted Voice");
      const invite = await createInviteLink(owner);
      await owner.getByRole("button", { name: "Create channel", exact: true }).click();
      await owner.getByLabel("Channel name").fill("product-voice"); await owner.getByRole("radio", { name: /Voice/ }).check();
      await owner.getByRole("dialog").getByRole("button", { name: "Create channel" }).click();
      await expect(owner.getByRole("heading", { level: 2, name: "product-voice" })).toBeVisible();
      const voiceUrl = owner.url();
      await owner.getByRole("button", { name: "Channel settings" }).click();
      await owner.getByRole("dialog").getByLabel("Speak for everyone").selectOption("deny");
      await owner.getByRole("dialog").getByLabel("Video for everyone").selectOption("deny");
      await owner.keyboard.press("Escape");
      for (const [index, name] of names.slice(1).entries()) {
        const page = await joinAsNewUser(browser, name, invite); pages.push(page); await attach(page, index + 1);
      }
      stage = "messaging-setup";
      // Explicit navigation to the existing product messaging setup; no anchor/storage injection.
      for (const page of pages) {
        await page.goto("/app/messages");
        await expect(page.getByRole("status").filter({ hasText: "Encrypted messaging ready." })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "Devices and recovery" }).click();
        await expect(page.getByRole("region", { name: "Encryption settings" })).toBeVisible();
        await page.goto(voiceUrl);
      }
      stage = "voice-join";
      // Sequential genuine joins exercise native generation transitions; no test-controlled context coordinator.
      for (const page of pages) await explicitJoin(page);
      for (const page of pages) await expect(audience(page).getByRole("listitem", { name: /^Voice participant / })).toHaveCount(3);
      stage = "native-sas-and-admission";
      await verifyPair(pages[0], names[0], pages[1], names[1], selection => { pairCandidates[0] = selection; });
      await verifyPair(pages[0], names[0], pages[2], names[2], selection => { pairCandidates[1] = selection; });
      await verifyPair(pages[1], names[1], pages[2], names[2], selection => { pairCandidates[2] = selection; });
      for (const page of pages) expect(await evidence(page)).toMatchObject({ captureCalls: 0, senders: 0, workers: 0 });
      stage = "initial-consent";
      // Canonical ordering is read from real authorized join responses, never supplied to product control.
      await expect.poll(() => memberIds.size).toBe(3);
      const sorted = [...pages].sort((a, b) => memberIds.get(a)!.localeCompare(memberIds.get(b)!));
      // The leader and one responder consent before the last responder. No capture/publication can occur.
      await consentToAudience(sorted.slice(0, 2));
      await Promise.all(sorted.slice(0, 2).map(async page => { await publicPhase(page, "negotiating"); await expect(audienceConsent(page)).toBeDisabled(); }));
      // Only this public status proves C actually consumed the thin local-consent-pending result.
      await publicPhase(sorted[2], "consent-pending");
      await checkpoint("initial-consent");
      for (const page of pages) {
        expect(await evidence(page)).toMatchObject({ captureCalls: 0, senders: 0, workers: 0 });
        await expect(audience(page).getByRole("listitem", { name: /^Voice participant / })).toHaveCount(3);
      }
      stage = "delayed-consent";
      await consentToAudience([sorted[2]]);
      await publicPhase(sorted[2], "negotiating");
      await expect(audienceConsent(sorted[2])).toBeDisabled();
      await checkpoint("delayed-consent");
      stage = "waiting-expiry";
      // No replacement proposal until every selected unfinished attempt has actually expired.
      await Promise.all(sorted.map(page => publicPhase(page, "retry-required")));
      await checkpoint("waiting-expiry");
      for (const page of pages) {
        await expect(audience(page).getByRole("listitem", { name: /^Voice participant / })).toHaveCount(3);
        expect(await evidence(page)).toMatchObject({ captureCalls: 0, senders: 0, workers: 0 });
      }
      stage = "responder-retry";
      await consentToAudience(sorted.slice(1));
      await Promise.all(sorted.slice(1).map(async page => { await publicPhase(page, "negotiating"); await expect(audienceConsent(page)).toBeDisabled(); }));
      await checkpoint("responder-retry");
      stage = "leader-retry";
      await expect(audienceConsent(sorted[0])).toBeEnabled();
      await audienceConsent(sorted[0]).click();
      leaderRetryDispatched = true;
      await publicPhase(sorted[0], ["negotiating", "preparing", "ready"]);
      await checkpoint("leader-retry");
      stage = "media-ready";
      for (const page of pages) await ready(page);
      await checkpoint("media-ready");
      for (const page of pages) await expect(audience(page).getByRole("listitem", { name: /^Voice participant / })).toHaveCount(3);
      await Promise.all(observation);
      expect(observationFailed).toBe(false); expect(grants).toHaveLength(3);
      for (const [index, page] of pages.entries()) {
        const snapshot = await evidence(page);
        expect(snapshot).toMatchObject({ captureCalls: 0, senders: 0, submitted: 3, ownAck: true, keysBeforeOwnAck: 3, ordered: true });
        const grant = grants.find(grant => grant.page === index)!;
        expect(grant.subscribe).toBe(true);
        if (index) {
          expect(grant).toMatchObject({ sources: [], publish: false });
          await expect(page.getByRole("button", { name: "Unmute microphone", exact: true }).first()).toBeDisabled();
          await expect(page.getByRole("button", { name: "Camera", exact: true })).toBeDisabled();
        }
        const worker = await page.request.get(snapshot.workerUrl);
        expect(worker.status()).toBe(200); expect(worker.headers()["content-type"]).toMatch(/javascript|ecmascript/);
        expect((await worker.text()).trimStart().startsWith("<!DOCTYPE")).toBe(false);
        const html = await page.request.get(voiceUrl); expect(html.headers()["content-security-policy"]).toContain("worker-src 'self'");
      }
      stage = "capture-and-decode";
      // Only explicit product source clicks invoke capture. No warm-up capture or source substitution.
      await owner.getByRole("button", { name: "Unmute microphone", exact: true }).first().click();
      await expect(owner.getByRole("button", { name: "Mute microphone", exact: true }).first()).toBeVisible({ timeout: 25_000 });
      await owner.getByRole("button", { name: "Camera", exact: true }).click();
      await expect(owner.getByRole("button", { name: "Stop camera", exact: true })).toBeVisible({ timeout: 25_000 });
      for (const page of pages.slice(1)) {
        const autoplay = page.getByRole("button", { name: "Enable audio playback" }).first();
        if (await autoplay.isVisible()) await autoplay.click();
        await expect.poll(async () => (await evidence(page)).audioEnergy, { timeout: 20_000 }).toBeGreaterThan(0);
        await expect.poll(async () => (await evidence(page)).videoFrames, { timeout: 20_000 }).toBeGreaterThan(10);
        const stats = await evidence(page); expect(stats.codecs).toContain("audio/opus"); expect(stats.codecs).toContain("video/vp8");
        expect(stats.samples).toBeGreaterThan(0); expect(stats.ordered).toBe(true); expect(stats.captureCalls).toBe(0);
        await expect(page.getByRole("region", { name: "Video" }).locator("video")).toHaveCount(1);
        const fingerprint = await videoFingerprint(page); expect(fingerprint.length > 0).toBe(true);
        await expect.poll(async () => (await videoFingerprint(page)) !== fingerprint).toBe(true);
      }
      await expectNoA11yViolations(pages[1]);
      await pages[1].setViewportSize({ width: 390, height: 844 });
      expect(await pages[1].evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await pages[1].screenshot({ path: testInfo.outputPath("product-voice-mobile.png"), mask: [audience(pages[1])] });
      await pages[1].setViewportSize({ width: 1280, height: 900 });
      await pages[1].getByRole("link", { name: "general", exact: true }).click();
      await expect(pages[1].getByRole("region", { name: "Voice connection" })).toContainText("Encrypted voice ready");
      await pages[1].getByRole("region", { name: "Voice connection" }).getByRole("link", { name: "product-voice" }).click();
      await expect(pages[1].getByRole("region", { name: "Video" }).locator("video")).toHaveCount(1);
      stage = "renewed-lease-past-jwt";
      // Real wall time + real product heartbeat, no timer mocking. Every original JWT has expired.
      const expiry = Math.max(...grants.map(grant => grant.expiry));
      while (Date.now() <= expiry + 1000) await owner.waitForTimeout(Math.min(1000, expiry + 1001 - Date.now()));
      for (const page of pages.slice(1)) {
        await expect(page.getByRole("status").filter({ hasText: "Encrypted voice ready" }).first()).toBeVisible();
        const before = await evidence(page);
        await expect.poll(async () => (await evidence(page)).videoFrames).toBeGreaterThan(before.videoFrames);
      }
      expect(grants).toHaveLength(3);
      await owner.getByRole("button", { name: "Mute microphone", exact: true }).first().click();
      await expect(owner.getByRole("button", { name: "Unmute microphone", exact: true }).first()).toBeVisible();
      await owner.getByRole("button", { name: "Stop camera", exact: true }).click();
      for (const page of pages.slice(1)) await expect(page.getByRole("region", { name: "Video" })).toHaveCount(0);
      await Promise.all(consoleObservations);
      const summary = await Promise.all(pages.map(evidence));
      const attached = await writeVoiceProductEvidence(testInfo, "voice-product-evidence", JSON.stringify({ exactNextProduct: true, accounts: 3, pairs: 3, separateAdmissions: 6, audienceParticipants: 3, jwtExpiredWithRenewedLease: true, leaderRetryDispatched, phaseCheckpoints, workerResponses, stats: summary.map(stats => ({ ...stats, workerUrl: undefined })), runtimeErrorCount: runtimeErrors.length, consoleErrorCount: consoleErrors.length, revocationDenials, consoleDiagnostics: consoleErrors.slice(0, 20) }));
      expect(attached.ok).toBe(true);
      stage = "connect-revocation";
      // Real channel permission UI revokes Connect. Product heartbeat/HTTP fences every affected peer.
      await owner.getByRole("button", { name: "Channel settings" }).click();
      await owner.getByRole("dialog").getByLabel("Connect for everyone").selectOption("deny");
      await owner.keyboard.press("Escape");
      for (const page of pages.slice(1)) {
        await expect(page.getByRole("status").filter({ hasText: "Voice stopped" }).first()).toBeVisible({ timeout: 20_000 });
        await expect.poll(async () => (await evidence(page)).allTerminated).toBe(true);
      }
      await Promise.all(consoleObservations);
      // The SFU removes revoked peers itself; SCTP cause 12 (user-initiated abort) is that removal, not a product fault.
      const revocationTeardown = (entry: (typeof consoleErrors)[number]) => entry.revoking && (entry.code === "data-channel-closed" || (entry.code === "data-channel-error" && entry.transport.some(part => part.detail === "sctp-failure" && part.cause === 12)));
      expect(runtimeErrors).toEqual([]); expect(consoleErrors.filter(entry => !revocationTeardown(entry))).toEqual([]);
      await owner.getByRole("button", { name: "Leave Voice", exact: true }).first().click();
      await expect.poll(async () => (await evidence(owner)).allTerminated).toBe(true);
    } catch (error) {
      primaryFailure = true; throw error;
    } finally {
      observing = false; stopResponseObservers.forEach(stop => stop());
      await Promise.all(consoleObservations);
      let cleanupFailed = false;
      await withVoiceProductCleanup(async () => {
        await Promise.all(observation); commitsClosed = true;
        const diagnostics = await Promise.all(pages.map(page => observeVoiceProductResult(async () => {
          const stats = await evidence(page);
          return { ...stats, workerUrl: undefined, ...await presentation(page), audienceVisible: await audience(page).isVisible(), rosterCount: await audience(page).getByRole("listitem", { name: /^Voice participant / }).count(), stopped: await page.getByRole("status").filter({ hasText: "Voice stopped" }).count() > 0 };
        }, { timeoutMs: 2000, stage: "diagnostic" })));
        const attachment = await writeVoiceProductEvidence(testInfo, "voice-product-evidence-final", JSON.stringify({ stage, leaderRetryDispatched, phaseCheckpoints, observationFailed, observationFailures, diagnostics, pairCandidates, grantCount: grants.length, runtimeErrorCount: runtimeErrors.length, consoleErrorCount: consoleErrors.length, revocationDenials, consoleDiagnostics: consoleErrors.slice(0, 20) }));
        if (!attachment.ok || diagnostics.some(result => !result.ok)) cleanupFailed = true;
      }, async () => {
        commitsClosed = true;
        const closed = await Promise.all(pages.map(page => observeVoiceProductResult(() => page.context().close(), { timeoutMs: 2000, stage: "cleanup" })));
        if (closed.some(result => !result.ok)) cleanupFailed = true;
      }).catch(() => { cleanupFailed = true; });
      if (!primaryFailure && (observationFailed || cleanupFailed)) throw new Error("Voice product observation or cleanup failed; see bounded diagnostic stages.");
    }
  });
});
