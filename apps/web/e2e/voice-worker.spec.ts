import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { AccessToken } from "livekit-server-sdk";
import ts from "typescript";

const require = createRequire(path.join(process.cwd(), "package.json"));
const sdkDirectory = path.dirname(require.resolve("livekit-client"));
const sdk = readFileSync(path.join(sdkDirectory, "livekit-client.esm.mjs"), "utf8");
const worker = readFileSync(path.join(sdkDirectory, "livekit-client.e2ee.worker.mjs"), "utf8");
function transpile(source: string): string {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}
const adapter = transpile(readFileSync(path.join(process.cwd(), "src/lib/voice/strict-worker.ts"), "utf8"));
const fixture = transpile(readFileSync(path.join(process.cwd(), "e2e/fixtures/voice-worker.ts"), "utf8"))
  .replace('"../../src/lib/voice/strict-worker"', '"/voice-proof/adapter.mjs"');

test.describe("native encrypted-only worker feasibility", () => {
  // Both projects are real Chromium. This is not Safari/ScriptTransform or physical-phone acceptance.
  test.setTimeout(60_000);
  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(10_000);
    await page.route("**/voice-proof/**", async (route) => {
      const name = new URL(route.request().url()).pathname;
      const modules: Record<string, string> = { "/voice-proof/sdk.mjs": sdk, "/voice-proof/worker.mjs": worker, "/voice-proof/adapter.mjs": adapter, "/voice-proof/fixture.mjs": fixture };
      if (modules[name]) await route.fulfill({ contentType: "text/javascript", body: modules[name] });
      else await route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Native voice worker proof</title><script type="importmap">{"imports":{"livekit-client":"/voice-proof/sdk.mjs"}}</script><script type="module" src="/voice-proof/fixture.mjs"></script>' });
    });
    await page.goto("/voice-proof/index");
    await expect.poll(() => page.evaluate(() => !!window.voiceProof)).toBe(true);
  });

  for (const scenario of ["normal", "unknown-identity", "missing-key", "wrong-key", "tamper", "plaintext-signaling"] as const) {
    test(`${scenario}: actual SFU audio frames obey the encryption boundary`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const room = `worker-proof-${crypto.randomUUID()}`;
      async function token(identity: string): Promise<string> {
        const value = new AccessToken(process.env.LIVEKIT_API_KEY ?? "devkey", process.env.LIVEKIT_API_SECRET ?? "secret", { identity, ttl: 60 });
        value.addGrant({ roomJoin: true, room, canPublish: identity === "sender", canSubscribe: true, canPublishData: false });
        return value.toJwt();
      }
      const input = { scenario, url: process.env.LIVEKIT_URL ?? "ws://localhost:7880", senderToken: await token("sender"), receiverToken: await token("receiver") };
      // Expected fail-closed disconnect can race publishTrack's resolution; inspect the worker reason below.
      await page.evaluate((value) => window.voiceProof.start(value).catch(() => undefined), input);
      if (scenario === "normal" || scenario === "unknown-identity") {
        await expect.poll(() => page.evaluate(() => window.voiceProof.snapshot().then((value) => value.decoded))).toBeGreaterThan(10);
        await expect.poll(() => page.evaluate(() => window.voiceProof.snapshot().then((value) => value.energy))).toBeGreaterThan(0);
        const before = await page.evaluate(() => window.voiceProof.snapshot());
        expect(before.encoded).toBeGreaterThan(10);
        expect(before.changed).toBeGreaterThan(10);
        expect(before.errors).toEqual([]);
        await page.evaluate((mode) => mode === "unknown-identity" ? window.voiceProof.unknown() : window.voiceProof.downgrade(), scenario);
        await expect.poll(() => page.evaluate(() => window.voiceProof.snapshot().then((value) => value.errors))).toContain(scenario === "unknown-identity" ? "Unadmitted media identity." : "Encryption downgrade refused.");
        await page.waitForTimeout(300);
        const stopped = await page.evaluate(() => window.voiceProof.snapshot());
        await page.waitForTimeout(500);
        expect((await page.evaluate(() => window.voiceProof.snapshot())).decoded).toBe(stopped.decoded);
      } else {
        await expect.poll(() => page.evaluate(() => window.voiceProof.snapshot().then((value) => value.errors.length))).toBeGreaterThan(0);
        const result = await page.evaluate(() => window.voiceProof.snapshot());
        expect(result.decoded).toBe(0);
        expect(result.energy).toBe(0);
        expect(result.errors).toContain(scenario === "plaintext-signaling" ? "Encryption downgrade refused." : "Native encryption worker failed.");
      }
      expect(errors).toEqual([]);
    });
  }

  test("UNKNOWN sender state is refused before a native encode transform can exist", async ({ page }) => {
    expect(await page.evaluate(() => window.voiceProof.unknownState())).toBe("Media started before encryption acknowledgement.");
  });
});
