import { expect, test, type Page, type Worker } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { AccessToken } from "livekit-server-sdk";
import ts from "typescript";
import type { Media, Metrics, Scenario } from "./fixtures/voice-worker";

const resolveDependency = createRequire(path.join(process.cwd(), "package.json"));
const sdkDirectory = path.dirname(resolveDependency.resolve("livekit-client"));
const sdk = readFileSync(path.join(sdkDirectory, "livekit-client.esm.mjs"), "utf8");
const worker = readFileSync(path.join(sdkDirectory, "livekit-client.e2ee.worker.mjs"), "utf8");
function transpile(source: string): string {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}
const adapter = transpile(readFileSync(path.join(process.cwd(), "src/lib/voice/strict-worker.ts"), "utf8"));
const fixture = transpile(readFileSync(path.join(process.cwd(), "e2e/fixtures/voice-worker.ts"), "utf8"))
  .replace('"../../src/lib/voice/strict-worker"', '"/voice-proof/adapter.mjs"');

async function prepare(page: Page, bundled: boolean): Promise<void> {
  page.setDefaultTimeout(10_000);
  if (bundled) {
    const response = await page.goto("/voice-worker-proof");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
    await page.getByRole("button", { name: "Load native worker proof", exact: true }).click();
    await expect(page.getByRole("button", { name: "Native worker proof ready", exact: true })).toBeVisible();
  } else {
    await page.route("**/voice-proof/**", async (route) => {
      const name = new URL(route.request().url()).pathname;
      const modules: Record<string, string> = { "/voice-proof/sdk.mjs": sdk, "/voice-proof/worker.mjs": worker, "/voice-proof/adapter.mjs": adapter, "/voice-proof/fixture.mjs": fixture };
      if (modules[name]) await route.fulfill({ contentType: "text/javascript", body: modules[name] });
      else await route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Native voice worker proof</title><script type="importmap">{"imports":{"livekit-client":"/voice-proof/sdk.mjs"}}</script><script type="module" src="/voice-proof/fixture.mjs"></script>' });
    });
    await page.goto("/voice-proof/index");
  }
  // Grant only the test origin; capture permission exposes usable local SFU ICE candidates in Chromium.
  await page.context().grantPermissions(["local-network-access", "microphone"], { origin: new URL(page.url()).origin });
  await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => stream.getTracks().forEach((track) => track.stop())));
  await expect.poll(() => page.evaluate(() => !!window.voiceProof)).toBe(true);
  if (bundled) {
    const url = await page.evaluate(() => window.voiceProof.snapshot().then((value) => value.workerUrl));
    expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    expect(new URL(url).pathname).toMatch(/^\/_next\/static\//);
    const asset = await page.request.get(url);
    expect(asset.status()).toBe(200);
    expect(createHash("sha256").update(await asset.body()).digest("hex")).toBe(createHash("sha256").update(worker).digest("hex"));
  }
}

async function start(page: Page, scenario: Scenario, media: Media): Promise<void> {
  const room = `worker-proof-${crypto.randomUUID()}`;
  async function token(identity: string): Promise<string> {
    const value = new AccessToken(process.env.LIVEKIT_API_KEY ?? "devkey", process.env.LIVEKIT_API_SECRET ?? "secret", { identity, ttl: 180 });
    value.addGrant({ roomJoin: true, room, canPublish: identity === "sender", canSubscribe: true, canPublishData: false });
    return value.toJwt();
  }
  const input = { scenario, media, url: process.env.LIVEKIT_URL ?? "ws://localhost:7880", senderToken: await token("sender"), receiverToken: await token("receiver") };
  const expectedWorker = await page.evaluate(() => window.voiceProof.snapshot().then((value) => value.workerUrl));
  const loadedWorkers: string[] = [];
  const observeWorker = (nativeWorker: Worker) => { loadedWorkers.push(nativeWorker.url()); };
  page.on("worker", observeWorker);
  try {
    await page.evaluate(async (value) => {
      try { await window.voiceProof.start(value); }
      // Native fail-closed disconnect may race publishTrack; other startup failures must propagate.
      catch (error) { if (!(await window.voiceProof.snapshot()).errors.length) throw error; }
    }, input);
    // Observe the actual browser worker bootstrap URLs, not only a separately fetched asset.
    await expect.poll(() => loadedWorkers.length).toBe(2);
    expect(loadedWorkers).toEqual([expectedWorker, expectedWorker]);
  } finally {
    page.off("worker", observeWorker);
  }
}

async function healthy(page: Page, media: Media, afterDecoded = 0): Promise<Metrics> {
  await expect.poll(() => page.evaluate(() => window.voiceProof.snapshot().then((value) => value.decoded))).toBeGreaterThan(afterDecoded + 10);
  await expect.poll(() => page.evaluate((kind) => window.voiceProof.snapshot().then((value) => kind === "video" ? value.framesDecoded : value.energy), media)).toBeGreaterThan(media === "video" ? 10 : 0);
  const result = await page.evaluate(() => window.voiceProof.snapshot());
  expect(result.encoded).toBeGreaterThan(10);
  expect(result.nonemptyEncoded).toBeGreaterThan(10);
  expect(result.changed).toBe(result.nonemptyEncoded);
  expect(result.unmatched).toBe(0);
  expect(result.encodeSetups).toBeGreaterThan(0);
  expect(result.decodeSetups).toBeGreaterThan(0);
  expect(result.scriptTransform).toBe(false);
  expect(result.codec.toLowerCase()).toBe(media === "video" ? "video/vp8" : "audio/opus");
  if (media === "video") expect(result.videoWidth).toBe(160);
  expect(result.errors).toEqual([]);
  return result;
}

async function stopped(page: Page, reason: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.voiceProof.snapshot().then((value) => value.errors))).toContain(reason);
  // Buffered frames may finish rendering, but native output must settle and stop.
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.voiceProof.snapshot());
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.voiceProof.snapshot());
  expect(after.decoded).toBe(before.decoded);
  expect(after.changed).toBe(after.nonemptyEncoded);
  expect(after.unmatched).toBe(0);
  expect(after.scriptTransform).toBe(false);
}

for (const bundled of [false, true]) test.describe(`${bundled ? "Next production bundle" : "native artifact"} encrypted-only worker`, () => {
  // Both projects are Chromium createEncodedStreams, not Safari/ScriptTransform or physical phones.
  test.setTimeout(60_000);
  test.skip(bundled && process.env.GITHUB_ACTIONS !== "true", "Production harness requires both explicit CI gates.");
  test.beforeEach(async ({ page }) => { await prepare(page, bundled); });
  for (const media of ["audio", "video"] as const) {
    for (const scenario of ["normal", "unknown-identity", "missing-key", "wrong-key", "tamper", "plaintext-signaling"] as const) {
      test(`${scenario}: actual SFU ${media} obeys the encryption boundary`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await start(page, scenario, media);
        if (scenario === "normal" || scenario === "unknown-identity") {
          await healthy(page, media);
          await page.evaluate((mode) => mode === "unknown-identity" ? window.voiceProof.unknown() : window.voiceProof.downgrade(), scenario);
          await stopped(page, scenario === "unknown-identity" ? "Unadmitted media identity." : "Encryption downgrade refused.");
        } else {
          await expect.poll(() => page.evaluate(() => window.voiceProof.snapshot().then((value) => value.errors.length))).toBeGreaterThan(0);
          const result = await page.evaluate(() => window.voiceProof.snapshot());
          expect(result.decoded).toBe(0);
          expect(result.framesDecoded).toBe(0);
          expect(result.energy).toBe(0);
          expect(result.errors).toContain(scenario === "plaintext-signaling" ? "Encryption downgrade refused." : "Native encryption worker failed.");
        }
        expect(errors).toEqual([]);
        console.info("native-voice-worker-proof", JSON.stringify({ profile: test.info().project.name, bundled, media, scenario, ...await page.evaluate(() => window.voiceProof.snapshot()) }));
      });
    }
    test(`${media}: native unsubscribe/resubscribe and both full reconnects retain encryption`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await start(page, "normal", media);
      let before = await healthy(page, media);
      await page.evaluate(() => window.voiceProof.resubscribe());
      let after = await healthy(page, media, before.decoded);
      expect(after.unsubscriptions).toBeGreaterThan(before.unsubscriptions);
      expect(after.subscriptions).toBeGreaterThan(before.subscriptions);
      for (const side of ["receiver", "sender"] as const) {
        before = after;
        await page.evaluate((value) => window.voiceProof.reconnect(value), side);
        after = await healthy(page, media, before.decoded);
        expect(after.reconnecting).toBeGreaterThan(before.reconnecting);
        expect(after.reconnected).toBeGreaterThan(before.reconnected);
        console.info("native-voice-worker-reconnect", JSON.stringify({ profile: test.info().project.name, bundled, media, side, ...after }));
      }
      await page.evaluate(() => window.voiceProof.downgrade());
      await stopped(page, "Encryption downgrade refused.");
      expect(errors).toEqual([]);
    });
  }
  test("UNKNOWN state is refused before a native encode transform exists", async ({ page }) => {
    expect(await page.evaluate(() => window.voiceProof.unknownState())).toBe("Media started before encryption acknowledgement.");
  });
});

test("production proof route defaults to HTTP 404 and requires both runtime gates", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "Server gates are independent of viewport.");
  test.setTimeout(60_000);
  for (const [github, optIn] of [["", ""], ["true", ""], ["", "1"]]) {
    // Same built standalone artefact, separate disposable process; no route mocking or production mutation.
    const server = spawn(process.execPath, [".next/standalone/apps/web/server.js"], {
      cwd: process.cwd(), stdio: "ignore",
      env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: "3201", GITHUB_ACTIONS: github, OPENDISCORD_VOICE_PROOF: optIn },
    });
    const exited = once(server, "exit");
    try {
      await expect.poll(async () => {
        try { return (await page.request.get("http://127.0.0.1:3201/voice-worker-proof", { timeout: 1000 })).status(); }
        catch { return 0; }
      }, { timeout: 10_000 }).toBe(404);
      const response = await page.goto("http://127.0.0.1:3201/voice-worker-proof");
      expect(response?.status()).toBe(404);
      expect(await page.evaluate(() => typeof window.voiceProof)).toBe("undefined");
      const three = await page.goto("http://127.0.0.1:3201/voice-worker-proof/three-browser");
      expect(three?.status()).toBe(404);
      expect(await page.evaluate(() => typeof window.threeVoice)).toBe("undefined");
      await expect(page.getByRole("button", { name: /native worker proof/i })).toHaveCount(0);
    } finally {
      server.kill("SIGTERM");
      const force = setTimeout(() => server.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(force); }
    }
  }
});
