import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { RoomServiceClient, TokenVerifier } from "livekit-server-sdk";
import { createVoiceHttpClient, voiceHttpSnapshotSchema } from "../src/lib/voice/http-client";
import { PublicServicePeer } from "../tests/fixtures/voice-service-peer";
import { createCommunity, newUserPage, signUp } from "./helpers";

test("Voice HTTP uses the real browser session and registered enrollment without activating media", async ({ browser }) => {
  const page = await newUserPage(browser), consoleErrors: string[] = [];
  page.on("pageerror", error => consoleErrors.push(error.name));
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource.*\b(403|405)\b/.test(message.text())) consoleErrors.push("unexpected-console-error"); });
  await signUp(page, "Voice Control HTTP");
  await createCommunity(page, "Voice HTTP browser");
  const createChannel = page.getByRole("button", { name: "Create channel", exact: true });
  if (!await createChannel.isVisible()) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(createChannel).toBeVisible();
  await createChannel.click();
  await page.getByLabel("Channel name").fill("control-http");
  await page.getByRole("radio", { name: /Voice/ }).check();
  await page.getByRole("dialog").getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "control-http" })).toBeVisible();
  const channelId = new URL(page.url()).pathname.split("/").at(-1)!;
  const anchor = { id: randomUUID(), secret: "a".repeat(64), name: "Explicit isolated HTTP test enrollment" };
  const input = { channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: "b".repeat(64), consent: true };
  // Only this disposable test browser's own cookie jar is used. No cookie/token value is read.
  const result = await page.evaluate(async ({ anchor, input }) => {
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
    };
    const registered = await post("/api/dm", { action: "register", input: anchor });
    const joined = await post("/api/voice/control", { action: "join", input }, { "x-dm-device": anchor.id, "x-dm-device-secret": anchor.secret });
    if (joined.status !== 200) return { registered: registered.status, joined: joined.status };
    const snapshot = joined.body;
    const binding = { callId: snapshot.callId, memberId: snapshot.memberId, joinNonce: snapshot.joinNonce, expectedGeneration: snapshot.generation };
    const headers = { "x-voice-member": snapshot.memberId, "x-voice-secret": input.enrollmentSecret };
    const heartbeat = await post("/api/voice/control", { action: "heartbeat", input: binding }, headers);
    const sync = await post("/api/voice/control", { action: "crypto", input: { ...binding, request: { kind: "sync" } } }, headers);
    const denied = await post("/api/voice/control", { action: "heartbeat", input: binding }, { ...headers, "x-voice-secret": "c".repeat(64) });
    return { registered: registered.status, joined: joined.status, heartbeat: heartbeat.status, sync: sync.status, empty: sync.body.events.length === 0, denied: denied.status, deniedCode: denied.body.code, snapshot: heartbeat.body, caches: [joined.cache, heartbeat.cache, sync.cache, denied.cache] };
  }, { anchor, input });
  expect(result).toMatchObject({ registered: 200, joined: 200, heartbeat: 200, sync: 200, empty: true, denied: 403, deniedCode: "forbidden", caches: Array(4).fill("private, no-store") });
  const snapshot = voiceHttpSnapshotSchema.parse(result.snapshot);
  const binding = { callId: snapshot.callId, memberId: snapshot.memberId, joinNonce: snapshot.joinNonce, expectedGeneration: snapshot.generation };
  const client = createVoiceHttpClient({ fetch: async (path, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected exact HTTP client JSON body.");
    // This test account's APIRequestContext shares its real browser cookie jar; never read cookies.
    const response = await page.context().request.fetch(String(path), { method: init.method, headers: { ...Object.fromEntries(new Headers(init.headers)), origin: new URL(page.url()).origin }, data: init.body, timeout: 10_000 });
    return new Response(await response.text(), { status: response.status(), headers: response.headers() });
  } });
  const lifetime = new AbortController();
  const peer = await PublicServicePeer.open({ snapshot, transport: ({ binding, request, signal }) => client.crypto(binding, request, input.enrollmentSecret, signal) });
  try {
    await peer.query(); await peer.sync();
    const grant = await client.token(binding, input.enrollmentSecret, lifetime.signal);
    const roomName = `voice:${snapshot.channelId}:${snapshot.callId}:${snapshot.generation}`;
    expect(grant.roomName).toBe(roomName);
    const key = process.env.LIVEKIT_API_KEY ?? "devkey", secret = process.env.LIVEKIT_API_SECRET ?? "secret";
    const claims = await new TokenVerifier(key, secret).verify(grant.token, 0);
    expect(claims.sub).toBe(snapshot.participantIdentity);
    expect(claims.video).toMatchObject({ room: roomName, roomJoin: true, canPublishData: false, canPublishSources: ["microphone", "camera", "screen_share", "screen_share_audio"] });
    expect(claims.exp! * 1000).toBeLessThanOrEqual(Date.parse(grant.expiresAt));
    expect(claims.exp! * 1000).toBeGreaterThan(Date.now());
    // Real CI LiveKit, exact canonical room filter. No SDK mocks or broad room inventory.
    const service = new RoomServiceClient(process.env.LIVEKIT_API_URL ?? (process.env.LIVEKIT_URL ?? "ws://localhost:7880").replace(/^ws/, "http"), key, secret);
    const rooms = await service.listRooms([roomName]);
    expect(rooms.map(room => room.name)).toEqual([roomName]);
  } finally {
    peer.close();
    await client.leave(binding, input.enrollmentSecret, lifetime.signal);
  }
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"]) {
    const response = await page.context().request.fetch("/api/voice/control", { method });
    expect(response.status()).toBe(405);
    const cacheDirectives = (response.headers()["cache-control"] ?? "").split(",").map(value => value.trim());
    expect(cacheDirectives).toEqual(expect.arrayContaining(["private", "no-store"]));
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  }
  expect(consoleErrors).toEqual([]);
  await page.context().close();
});
