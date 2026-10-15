import { expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { BrowserVoiceTransport } from "./fixtures/voice-three-transport";
import type { Binding } from "./fixtures/voice-three-contracts";
import type { MediaKind, MediaSnapshot } from "./fixtures/voice-three-media";

type Device = { page: Page; context: BrowserContext; binding: Binding; workers: string[]; errors: string[]; token: string; fingerprint: string; consoleErrors: number; failedRequests: number };
type Harness = { devices: Device[]; transport: BrowserVoiceTransport; room: string; url: string; close: () => Promise<void> };
const dependency = createRequire(path.join(process.cwd(), "package.json"));
const worker = readFileSync(path.join(path.dirname(dependency.resolve("livekit-client")), "livekit-client.e2ee.worker.mjs"));
const nativeHash = createHash("sha256").update(worker).digest("hex");

async function open(browser: Browser, profile: Pick<BrowserContextOptions, "viewport" | "isMobile" | "hasTouch" | "deviceScaleFactor" | "userAgent">): Promise<Harness> {
  const call = randomUUID(), room = `three-browser-${call}`;
  const bindings: Binding[] = [0, 1, 2].map(() => { const member = randomUUID(); return { call, member, user: `@voice_${call}_${member}:opendiscord.invalid`, device: randomUUID() }; });
  const transport = new BrowserVoiceTransport(bindings), devices: Device[] = [];
  const url = process.env.LIVEKIT_URL ?? "ws://localhost:7880", key = process.env.LIVEKIT_API_KEY ?? "devkey", secret = process.env.LIVEKIT_API_SECRET ?? "secret";
  const close = async () => {
    for (const device of devices) { await device.page.evaluate(() => window.threeVoice?.close()).catch(() => undefined); await device.context.close(); }
    transport.close();
    await new RoomServiceClient(url.replace(/^ws/, "http"), key, secret).deleteRoom(room).catch(() => undefined);
  };
  try {
    for (const binding of bindings) {
      const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, deviceScaleFactor: profile.deviceScaleFactor, userAgent: profile.userAgent, baseURL: "http://localhost:3200" });
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      const access = new AccessToken(key, secret, { identity: binding.member, ttl: 300 });
      access.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false });
      const device: Device = { context, page, binding, workers: [], errors: [], token: await access.toJwt(), fingerprint: "", consoleErrors: 0, failedRequests: 0 }; devices.push(device);
      page.on("pageerror", (error) => device.errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") device.consoleErrors++; });
      page.on("requestfailed", () => { device.failedRequests++; });
      page.on("worker", (value) => device.workers.push(value.url()));
      await page.exposeBinding("voiceThreeTransport", (source, request: unknown) => {
        if (source.page !== page || source.frame !== page.mainFrame()) throw new Error("Unregistered browser transport owner.");
        return transport.submit(binding, request);
      });
      const response = await page.goto("/voice-worker-proof/three-browser");
      expect(response?.status()).toBe(200); expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
      await page.getByRole("button", { name: "Load three browser proof", exact: true }).click();
      await expect(page.getByRole("button", { name: "Three browser proof ready", exact: true })).toBeVisible();
      await context.grantPermissions(["local-network-access", "microphone"], { origin: new URL(page.url()).origin });
      await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => stream.getTracks().forEach((track) => track.stop())));
      device.fingerprint = (await page.evaluate((input) => window.threeVoice.open(input), { binding, peers: bindings })).fingerprint;
      const assetUrl = await page.evaluate(() => window.threeVoice.snapshot().then((value) => value.workerUrl));
      expect(new URL(assetUrl).origin).toBe(new URL(page.url()).origin); expect(new URL(assetUrl).pathname).toMatch(/^\/_next\/static\//);
      const asset = await page.request.get(assetUrl); expect(asset.status()).toBe(200);
      expect(createHash("sha256").update(await asset.body()).digest("hex")).toBe(nativeHash);
    }
    expect(new Set(devices.map((device) => device.fingerprint)).size).toBe(3);
    return { devices, transport, room, url, close };
  } catch (error) { await close(); throw error; }
}
async function drain(devices: Device[], transport: BrowserVoiceTransport): Promise<void> {
  for (let round = 0; round < 8; round++) {
    for (const device of devices) await device.page.evaluate(() => window.threeVoice.sync());
    if (devices.every((device) => transport.queued(device.binding) === 0)) return;
  }
  throw new Error("Browser control drain exceeded bound.");
}
async function verify(a: Device, b: Device, transport: BrowserVoiceTransport, admit = true): Promise<void> {
  await a.page.evaluate(() => window.threeVoice.query()); await b.page.evaluate(() => window.threeVoice.query());
  const flow = await a.page.evaluate((member) => window.threeVoice.request(member), b.binding.member);
  await b.page.evaluate(() => window.threeVoice.sync());
  await b.page.evaluate(({ member, flow }) => window.threeVoice.verify(member, flow, "accept"), { member: a.binding.member, flow });
  await a.page.evaluate(() => window.threeVoice.sync());
  await a.page.evaluate(({ member, flow }) => window.threeVoice.verify(member, flow, "start"), { member: b.binding.member, flow });
  await b.page.evaluate(() => window.threeVoice.sync());
  await b.page.evaluate(({ member, flow }) => window.threeVoice.verify(member, flow, "accept-sas"), { member: a.binding.member, flow });
  await drain([a, b], transport);
  const left = await a.page.evaluate(({ member, flow }) => window.threeVoice.sas(member, flow), { member: b.binding.member, flow });
  const right = await b.page.evaluate(({ member, flow }) => window.threeVoice.sas(member, flow), { member: a.binding.member, flow });
  expect(left.decimals).toHaveLength(3); expect(left.decimals).toEqual(right.decimals);
  for (const [own, peer] of [[a, b], [b, a]]) await own.page.evaluate(({ member, flow }) => window.threeVoice.verify(member, flow, "confirm"), { member: peer.binding.member, flow });
  await drain([a, b], transport);
  for (const [own, peer] of [[a, b], [b, a]]) {
    expect((await own.page.evaluate(({ member, flow }) => window.threeVoice.sas(member, flow), { member: peer.binding.member, flow })).done).toBe(true);
    await own.page.evaluate(() => window.threeVoice.query());
    expect(await own.page.evaluate((member) => window.threeVoice.trusted(member), peer.binding.member)).toBe(true);
    if (admit) await own.page.evaluate((member) => window.threeVoice.admit(member), peer.binding.member);
  }
}
async function setup(harness: Harness): Promise<void> {
  const [a, b, c] = harness.devices;
  await verify(a, b, harness.transport);
  const first = randomUUID();
  for (const own of [a, b]) await own.page.evaluate(({ epoch, members }) => window.threeVoice.begin(epoch, members), { epoch: first, members: [a.binding.member, b.binding.member, c.binding.member] });
  const before = harness.transport.submissions;
  const cBefore = harness.transport.delivered.get(c.binding.member) ?? 0;
  expect(await a.page.evaluate((member) => window.threeVoice.distribute(member).then(() => "allowed", (error: Error) => error.message), c.binding.member)).toBe("Explicit admission required.");
  expect(harness.transport.submissions).toBe(before); expect(harness.transport.delivered.get(c.binding.member) ?? 0).toBe(cBefore);
  expect((await c.page.evaluate(() => window.threeVoice.snapshot())).material).toBe(0);
  await verify(a, c, harness.transport, false);
  const verifiedBefore = harness.transport.submissions, verifiedCBefore = harness.transport.delivered.get(c.binding.member) ?? 0;
  expect(await a.page.evaluate((member) => window.threeVoice.distribute(member).then(() => "allowed", (error: Error) => error.message), c.binding.member)).toBe("Explicit admission required.");
  expect(harness.transport.submissions).toBe(verifiedBefore); expect(harness.transport.delivered.get(c.binding.member) ?? 0).toBe(verifiedCBefore);
  for (const [own, peer] of [[a, c], [c, a]]) await own.page.evaluate((member) => window.threeVoice.admit(member), peer.binding.member);
  await verify(b, c, harness.transport);
}
async function epoch(harness: Harness, devices = harness.devices): Promise<void> {
  const id = randomUUID(), members = devices.map((device) => device.binding.member);
  for (const device of devices) await device.page.evaluate(({ id, members }) => window.threeVoice.begin(id, members), { id, members });
  for (const device of devices) await device.page.evaluate(() => window.threeVoice.distribute());
  await drain(devices, harness.transport);
  for (const device of devices) {
    const snapshot = await device.page.evaluate(() => window.threeVoice.snapshot());
    expect(snapshot.material).toBe(devices.length); expect(snapshot.prepared).toHaveLength(devices.length - 1); expect(snapshot.ready).toHaveLength(0);
  }
}
async function connect(harness: Harness, devices = harness.devices): Promise<void> {
  for (const device of devices) await device.page.evaluate((input) => window.threeVoice.connect(input), { url: harness.url, token: device.token });
}
async function ready(harness: Harness, devices = harness.devices): Promise<void> {
  for (const device of devices) await device.page.evaluate(() => window.threeVoice.keyReady());
  await drain(devices, harness.transport);
  for (const device of devices) expect((await device.page.evaluate(() => window.threeVoice.snapshot())).ready).toHaveLength(devices.length - 1);
}
function ordering(value: MediaSnapshot, local: string, members: string[]): void {
  expect(value.diagnostic).toBe(false); expect(value.fence).toBe(true); expect(value.errors).toEqual([]); expect(value.scriptTransform).toBe(false); expect(value.encodedStreams).toBe(true);
  const localEnable = value.trace.find((item) => item.kind === "enable" && item.identity === local);
  const localAck = value.trace.find((item) => item.kind === "ack" && item.identity === local);
  expect(localEnable).toBeDefined(); expect(localAck).toBeDefined();
  for (const identity of members) expect(value.trace.some((item) => item.kind === "setKey" && item.identity === identity && item.sequence < localEnable!.sequence)).toBe(true);
  expect(localEnable!.sequence).toBeLessThan(localAck!.sequence);
  const keyReady = value.trace.find((item) => item.kind === "key-ready-sent"), receipts = value.trace.find((item) => item.kind === "receipts-complete"), publish = value.trace.find((item) => item.kind === "publish");
  expect(keyReady).toBeDefined(); expect(receipts).toBeDefined(); expect(publish).toBeDefined();
  expect(localAck!.sequence).toBeLessThan(keyReady!.sequence); expect(receipts!.sequence).toBeLessThan(publish!.sequence);
  for (const subscription of value.trace.filter((item) => item.kind === "subscribe")) {
    expect(value.trace.some((item) => item.kind === "publication" && item.track === subscription.track && item.sequence < subscription.sequence)).toBe(true);
    expect(value.trace.some((item) => item.kind === "ack" && item.identity === subscription.identity && item.sequence < subscription.sequence)).toBe(true);
  }
  for (const decoded of value.trace.filter((item) => item.kind === "decode")) expect(value.trace.some((item) => item.kind === "ack" && item.identity === decoded.identity && item.sequence < decoded.sequence)).toBe(true);
  const encoded = value.frames.filter((item) => item.direction === "encode");
  expect(encoded.length).toBeGreaterThan(0);
  for (const frame of encoded) { expect(frame.nonempty).toBeGreaterThan(10); expect(frame.changed).toBe(frame.nonempty); expect(frame.unmatched).toBe(0); }
}
async function healthy(device: Device, peers: Device[], media: MediaKind): Promise<MediaSnapshot> {
  await expect.poll(async () => {
    const snapshot = (await device.page.evaluate(() => window.threeVoice.snapshot())).media;
    return peers.filter((peer) => peer !== device).every((peer) => snapshot?.streams.some((stream) => stream.identity === peer.binding.member && stream.kind === media && stream.bytes > 100 && (media === "audio" ? stream.energy > 0 && stream.samples > 0 : stream.frames > 10 && stream.width === 160)));
  }, { timeout: 20_000 }).toBe(true);
  const value = (await device.page.evaluate(() => window.threeVoice.snapshot())).media;
  expect(value).toBeDefined(); if (!value) throw new Error("No media snapshot.");
  ordering(value, device.binding.member, peers.map((peer) => peer.binding.member));
  expect(value.streams.filter((stream) => stream.kind === media)).toHaveLength(peers.length - 1);
  for (const stream of value.streams.filter((stream) => stream.kind === media)) expect(stream.codec.toLowerCase()).toBe(media === "audio" ? "audio/opus" : "video/vp8");
  expect(device.errors).toEqual([]); expect(device.consoleErrors).toBe(0); expect(device.failedRequests).toBe(0); expect(device.workers).toContain(value.workerUrl);
  return value;
}

test.describe("three actual browsers: independently verified ephemeral control and native media", () => {
  test.setTimeout(120_000);
  test.skip(process.env.GITHUB_ACTIONS !== "true", "Requires the explicitly gated production Next fixture and isolated SFU.");
  for (const media of ["audio", "video"] as const) test(`${media}: all three SAS pairs, authenticated readiness, six streams and fresh membership epoch`, async ({ browser }, info) => {
    const harness = await open(browser, info.project.use);
    try {
      await setup(harness); await epoch(harness); await connect(harness);
      expect(await harness.devices[0].page.evaluate((input) => window.threeVoice.connect(input).then(() => "allowed", (error: Error) => error.message), { url: harness.url, token: harness.devices[0].token })).toBe("Fresh epoch required for normal worker replacement.");
      for (const device of harness.devices) {
        expect(await device.page.evaluate((kind) => window.threeVoice.publish(kind).then(() => "allowed", (error: Error) => error.message), media)).toBe("All current authenticated key-ready receipts required.");
        expect((await device.page.evaluate(() => window.threeVoice.snapshot())).media?.publications).toBe(0);
      }
      await ready(harness);
      for (const device of harness.devices) await device.page.evaluate((kind) => window.threeVoice.publish(kind), media);
      for (const device of harness.devices) {
        const value = await healthy(device, harness.devices, media);
        console.info("three-browser-native-proof", JSON.stringify({ profile: info.project.name, media, member: device.binding.member, workerHash: nativeHash, ...value }));
      }
      const [a, b, c] = harness.devices;
      const old = (await a.page.evaluate(() => window.threeVoice.snapshot())).media?.generation;
      const cMaterials = (await c.page.evaluate(() => window.threeVoice.snapshot())).receivedMaterial;
      await c.page.evaluate(() => window.threeVoice.closeMedia());
      await epoch(harness, [a, b]);
      const submissions = harness.transport.submissions, queued = harness.transport.queued(c.binding);
      expect(await a.page.evaluate((member) => window.threeVoice.distribute(member).then(() => "allowed", (error: Error) => error.message), c.binding.member)).toBe("Recipient outside current media audience.");
      expect(harness.transport.submissions).toBe(submissions); expect(harness.transport.queued(c.binding)).toBe(queued);
      await b.page.evaluate((member) => window.threeVoice.stale(member), a.binding.member);
      await drain([a, b], harness.transport);
      expect((await a.page.evaluate(() => window.threeVoice.snapshot())).ignored).toBeGreaterThan(0);
      expect((await a.page.evaluate(() => window.threeVoice.snapshot())).ready).toHaveLength(0);
      await connect(harness, [a, b]); await ready(harness, [a, b]);
      for (const device of [a, b]) await device.page.evaluate((kind) => window.threeVoice.publish(kind), media);
      for (const device of [a, b]) await healthy(device, [a, b], media);
      expect((await a.page.evaluate(() => window.threeVoice.snapshot())).media?.generation).not.toBe(old);
      expect((await c.page.evaluate(() => window.threeVoice.snapshot())).receivedMaterial).toBe(cMaterials);
      expect(harness.transport.queued(c.binding)).toBe(0);
    } finally { await harness.close(); }
  });

  test("an omitted expected key cannot release normal publication", async ({ browser }, info) => {
    const harness = await open(browser, info.project.use);
    try {
      await setup(harness); await epoch(harness);
      const [a, b] = harness.devices;
      await a.page.evaluate((input) => window.threeVoice.connect(input), { url: harness.url, token: a.token });
      await b.page.evaluate((input) => window.threeVoice.connect(input).catch(() => undefined), { url: harness.url, token: b.token, omit: a.binding.member });
      const value = (await b.page.evaluate(() => window.threeVoice.snapshot())).media;
      expect(value?.errors).toContain("Missing expected key before local fence.");
      expect(await b.page.evaluate(() => window.threeVoice.keyReady().then(() => "allowed", (error: Error) => error.message))).toBe("Current normal worker fence required.");
      expect(await a.page.evaluate(() => window.threeVoice.publish("audio").then(() => "allowed", (error: Error) => error.message))).toBe("All current authenticated key-ready receipts required.");
      expect((await a.page.evaluate(() => window.threeVoice.snapshot())).media?.publications).toBe(0);
    } finally { await harness.close(); }
  });

  for (const media of ["audio", "video"] as const) for (const diagnostic of ["missing-key", "wrong-key"] as const) test(`${media}: isolated native ${diagnostic} receiver drops ciphertext and cannot claim normal readiness`, async ({ browser }, info) => {
    const harness = await open(browser, info.project.use);
    try {
      await setup(harness); await epoch(harness); await connect(harness); await ready(harness);
      for (const device of harness.devices) await device.page.evaluate((kind) => window.threeVoice.publish(kind), media);
      for (const device of harness.devices) await healthy(device, harness.devices, media);
      const [a, b] = harness.devices;
      // Fresh diagnostic worker; normal admission/readiness cannot be re-enabled by this entry point.
      await b.page.evaluate((input) => window.threeVoice.connect(input).catch(() => undefined), { url: harness.url, token: b.token, diagnostic, target: a.binding.member });
      await expect.poll(async () => (await b.page.evaluate(() => window.threeVoice.snapshot())).media?.frames.filter((frame) => frame.direction === "decode" && frame.identity === a.binding.member).reduce((sum, frame) => sum + frame.input, 0) ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
      const result = (await b.page.evaluate(() => window.threeVoice.snapshot())).media;
      expect(result?.diagnostic).toBe(true);
      expect(result?.frames.filter((frame) => frame.direction === "decode" && frame.identity === a.binding.member).every((frame) => frame.output === 0)).toBe(true);
      expect(await b.page.evaluate(() => window.threeVoice.keyReady().then(() => "allowed", (error: Error) => error.message))).toBe("Current normal worker fence required.");
      expect(await b.page.evaluate((kind) => window.threeVoice.publish(kind).then(() => "allowed", (error: Error) => error.message), media)).toBe("All current authenticated key-ready receipts required.");
      await b.page.waitForTimeout(300);
      const before = (await b.page.evaluate(() => window.threeVoice.snapshot())).media?.frames.reduce((sum, frame) => sum + frame.output, 0);
      await b.page.waitForTimeout(500);
      const after = (await b.page.evaluate(() => window.threeVoice.snapshot())).media;
      expect(after?.frames.reduce((sum, frame) => sum + frame.output, 0)).toBe(before);
      expect(after?.stopped).toBe(true);
      console.info("three-browser-native-diagnostic", JSON.stringify({ profile: info.project.name, media, diagnostic, result: after }));
    } finally { await harness.close(); }
  });
});
