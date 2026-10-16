import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaSession, InstalledVoiceMediaContext, VoiceMediaBridge, VoiceMediaView } from "@/lib/voice/media-session";
import { VOICE_CONTROL_EVENT, voiceControlParty, type VoiceOwnerControl } from "@/lib/voice/owner-control";
import type { VoiceSnapshot } from "@/lib/voice/contracts";

type RoomDouble = {
  events: Map<string, (...args: unknown[]) => void>;
  worker: Worker;
  disconnect: ReturnType<typeof vi.fn>;
  localParticipant: { trackPublications: Map<string, unknown>; setMicrophoneEnabled: ReturnType<typeof vi.fn>; setCameraEnabled: ReturnType<typeof vi.fn>; setScreenShareEnabled: ReturnType<typeof vi.fn> };
};
const harness = vi.hoisted(() => ({ rooms: [] as RoomDouble[], keys: true, connect: undefined as Promise<void> | undefined }));
vi.mock("livekit-client", () => {
  class Keys {
    keys = new Map<string, CryptoKey>();
    onSetEncryptionKey(key: CryptoKey, identity: string) { this.keys.set(identity, key); }
  }
  class Room {
    events = new Map<string, (...args: unknown[]) => void>();
    remoteParticipants = new Map();
    localParticipant = { trackPublications: new Map(), setMicrophoneEnabled: vi.fn(async () => undefined), setCameraEnabled: vi.fn(async () => undefined), setScreenShareEnabled: vi.fn(async () => undefined) };
    disconnect = vi.fn(async () => {});
    worker: Worker;
    constructor(private readonly options: { encryption: { worker: Worker; keyProvider: Keys } }) { this.worker = options.encryption.worker; harness.rooms.push(this); }
    on(event: string, callback: (...args: unknown[]) => void) { this.events.set(event, callback); return this; }
    async setE2EEEnabled() {}
    async connect() {
      if (harness.connect) await harness.connect;
      if (harness.keys) this.options.encryption.keyProvider.keys.forEach((key, participantIdentity) => this.worker.postMessage({ kind: "setKey", data: { key, participantIdentity, keyIndex: 0 } }));
    }
  }
  return { BaseKeyProvider: Keys, Room, Encryption_Type: { NONE: 0, GCM: 1, CUSTOM: 2 }, RoomEvent: { Reconnecting: "reconnecting", SignalReconnecting: "signalReconnecting", Disconnected: "disconnected", EncryptionError: "encryptionError", TrackPublished: "trackPublished", TrackSubscribed: "trackSubscribed", TrackUnsubscribed: "trackUnsubscribed", AudioPlaybackStatusChanged: "audioPlaybackChanged", LocalTrackPublished: "localTrackPublished", LocalTrackUnpublished: "localTrackUnpublished", TrackMuted: "trackMuted", TrackUnmuted: "trackUnmuted", ParticipantPermissionsChanged: "participantPermissionsChanged" }, Track: { Kind: { Audio: "audio", Video: "video" }, Source: { Microphone: "microphone", Camera: "camera", ScreenShare: "screen_share" } } };
});
class WorkerDouble extends EventTarget {
  posts: unknown[] = [];
  terminated = false;
  postMessage(message: unknown) { this.posts.push(message); }
  terminate() { this.terminated = true; }
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
let media: MediaSession | undefined;
beforeEach(() => {
  harness.rooms.length = 0; harness.keys = true; harness.connect = undefined;
  vi.stubGlobal("Worker", WorkerDouble);
  vi.stubGlobal("RTCRtpSender", class { createEncodedStreams() {} });
  vi.stubGlobal("RTCRtpReceiver", class { createEncodedStreams() {} });
  vi.stubGlobal("location", { href: "https://example.test/app" });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => { media?.fence(); media = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup(sources: ("microphone" | "camera" | "screen_share" | "screen_share_audio")[] = ["microphone", "camera"]) {
  const callId = crypto.randomUUID(), channelId = crypto.randomUUID();
  const members = [0, 1, 2].map(i => { const memberId = crypto.randomUUID(); return { memberId, userId: `user${i}`, anchorDeviceId: crypto.randomUUID(), voiceUserId: `@voice_${callId}_${memberId}:opendiscord.local`, voiceDeviceId: crypto.randomUUID(), joinNonce: crypto.randomUUID(), participantIdentity: `v1:${memberId}`, displayName: `User ${i}`, state: "active" as const }; }).sort((a, b) => a.memberId.localeCompare(b.memberId));
  const self = members[0];
  const snapshot: VoiceSnapshot = { callId, channelId, generation: 1, memberId: self.memberId, joinNonce: self.joinNonce, voiceUserId: self.voiceUserId, voiceDeviceId: self.voiceDeviceId, participantIdentity: self.participantIdentity, members, removals: [], serverTime: new Date(0).toISOString(), leaseExpiresAt: new Date(30000).toISOString() };
  const context: InstalledVoiceMediaContext = { snapshot, epochId: crypto.randomUUID(), proposalSequence: 3, reference: crypto.randomUUID(), audience: members.map(voiceControlParty), self: voiceControlParty(self), deadline: 10000 };
  let current = true;
  const presentation = vi.fn<(view: VoiceMediaView) => void>();
  const send = vi.fn<(control: VoiceOwnerControl) => Promise<void>>(async () => {}), fatal = vi.fn();
  const token = vi.fn(async () => ({ grant: { token: "deterministic-public-room-double", url: "wss://example.test", snapshot, roomName: `voice:${channelId}:${callId}:1`, participantIdentity: self.participantIdentity, sources, canPublishData: false as const, expiresAt: new Date(30000).toISOString() }, deadline: 30000 }));
  const bridge: VoiceMediaBridge = { current() { if (!current) throw new Error("Stale context."); }, send, fatal, token, presentation };
  return { context, bridge, send, fatal, token, presentation, retire() { current = false; }, peers: context.audience.slice(1) };
}
type Setup = ReturnType<typeof setup>;
async function open(test: Setup) {
  const { MediaSession } = await import("@/lib/voice/media-session");
  media = new MediaSession(test.context, test.bridge); media.start(); await settle();
  return media;
}
function peerMaterial(test: Setup, index: number): VoiceOwnerControl {
  const peer = test.peers[index];
  return { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: test.context.snapshot.callId, generation: 1, epochId: test.context.epochId, proposalSequence: test.context.proposalSequence, sender: peer, recipient: test.context.self, publisher: peer, audience: [...test.context.audience], keyId: crypto.randomUUID(), reference: crypto.randomUUID(), transaction: crypto.randomUUID(), material: Buffer.alloc(32, index + 1).toString("base64") };
}
function receipt(test: Setup, index: number, kind: "prepared" | "key-ready"): VoiceOwnerControl {
  const sent = test.send.mock.calls.map(([control]) => control).find(control => control.kind === "material" && control.recipient.memberId === test.peers[index].memberId)!;
  return { version: 1, purpose: VOICE_CONTROL_EVENT, kind, callId: sent.callId, generation: sent.generation, epochId: sent.epochId, proposalSequence: sent.proposalSequence, sender: sent.recipient, recipient: sent.sender, publisher: sent.publisher, audience: sent.audience, keyId: sent.keyId, reference: sent.reference, transaction: crypto.randomUUID() };
}
async function prepare(test: Setup) {
  await media!.consume(peerMaterial(test, 0)); await media!.consume(peerMaterial(test, 1));
  await media!.consume(receipt(test, 0, "prepared")); await media!.consume(receipt(test, 1, "prepared")); await settle();
}
function ack(worker: Worker, identity: string) { worker.dispatchEvent(new MessageEvent("message", { data: { kind: "enable", data: { participantIdentity: identity, enabled: true } } })); }
const ownAck = (test: Setup) => ack(harness.rooms[0].worker, test.context.self.participantIdentity);

describe("MediaSession deterministic public Room/Worker effect doubles (not real ACK/media evidence)", () => {
  it("reports keying separately from ready and clears all presentation synchronously on fence", async () => {
    const test = setup([]); await open(test); await prepare(test); ownAck(test); await settle();
    expect(test.presentation.mock.lastCall?.[0]).toMatchObject({ mediaState: "keying", sources: [], microphone: false, camera: false, screenShare: false, tiles: [] });
    await media!.consume(receipt(test, 0, "key-ready")); await media!.consume(receipt(test, 1, "key-ready"));
    const ready = test.presentation.mock.lastCall![0];
    expect(ready.mediaState).toBe("ready"); expect(Object.isFrozen(ready)).toBe(true);
    expect(JSON.stringify(ready)).not.toMatch(/keyId|reference|token|material|CryptoKey|participantIdentity/);
    expect(harness.rooms[0].localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    media!.fence();
    expect(test.presentation.mock.lastCall?.[0]).toEqual({ mediaState: "ended", sources: [], microphone: false, camera: false, screenShare: false, audioBlocked: false, tiles: [] });
    expect(() => media!.mountVideo("obsolete", {} as HTMLVideoElement)).toThrow("fenced");
  });
  it("mounts each remote once, detaches presentation without stopping the call and rejects obsolete tile IDs", async () => {
    class Element {
      children: Element[] = []; muted = false; playsInline = false;
      append(element: Element) { this.children.push(element); }
      contains(element: Element) { return this.children.includes(element); }
      remove() {}
    }
    class Audio extends Element {}
    class Video extends Element {}
    vi.stubGlobal("HTMLAudioElement", Audio); vi.stubGlobal("HTMLVideoElement", Video);
    vi.stubGlobal("document", { createElement: () => new Audio() });
    const test = setup([]); await open(test); await prepare(test); ownAck(test); await settle();
    const track = { attach: vi.fn((element: Element) => element), detach: vi.fn(() => []), stop: vi.fn() };
    const publication = { source: "camera", kind: "video", mimeType: "video/vp8", isEncrypted: true, trackInfo: { encryption: 1 }, setSubscribed: vi.fn() };
    const peer = { identity: test.peers[0].participantIdentity };
    harness.rooms[0].events.get("trackPublished")!(publication, peer); ack(harness.rooms[0].worker, peer.identity); await settle();
    harness.rooms[0].events.get("trackSubscribed")!(track, publication, peer);
    const tile = test.presentation.mock.lastCall![0].tiles[0];
    expect(tile).toMatchObject({ memberId: test.peers[0].memberId, source: "camera", kind: "video", isLocal: false });
    expect(Object.isFrozen(tile)).toBe(true);
    const element = new Video() as unknown as HTMLVideoElement;
    const detach = media!.mountVideo(tile.id, element);
    expect(track.attach).toHaveBeenCalledExactlyOnceWith(element);
    detach(); detach(); expect(track.detach).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled(); expect(harness.rooms[0].disconnect).not.toHaveBeenCalled();
    media!.mountVideo(tile.id, element);
    harness.rooms[0].events.get("trackUnsubscribed")!(track);
    expect(() => media!.mountVideo(tile.id, element)).toThrow("no longer current");
    media!.fence();
    const calls = test.presentation.mock.calls.length;
    harness.rooms[0].events.get("audioPlaybackChanged")!();
    expect(test.presentation).toHaveBeenCalledTimes(calls);
  });
  it("rejects positive ownACK before all exact setKey submissions without readiness or capture", async () => {
    harness.keys = false; const test = setup(); await open(test); await prepare(test); ownAck(test); await settle();
    expect(test.fatal).toHaveBeenCalledOnce(); expect(test.send.mock.calls.some(([control]) => control.kind === "key-ready")).toBe(false);
    expect(harness.rooms[0].localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });
  it("prepared and ownACK cannot publish until every exact receiver is key-ready", async () => {
    const test = setup(); await open(test); await prepare(test); ownAck(test); await settle();
    await expect(media!.setSource("camera", true)).rejects.toThrow("Media not ready");
    await media!.consume(receipt(test, 0, "key-ready"));
    await expect(media!.setSource("camera", true)).rejects.toThrow("Media not ready");
    await media!.consume(receipt(test, 1, "key-ready")); await media!.setSource("camera", true);
    expect(harness.rooms[0].localParticipant.setCameraEnabled).toHaveBeenCalledExactlyOnceWith(true, undefined, { videoCodec: "vp8", simulcast: false });
  });
  it("imports material once, makes duplicates inert, and rejects conflicting material/q/reference/receipt", async () => {
    const test = setup(); await open(test); const material = peerMaterial(test, 0);
    await media!.consume(material); const count = test.send.mock.calls.length;
    await media!.consume(material); await media!.consume({ ...material, transaction: crypto.randomUUID() });
    expect(test.send).toHaveBeenCalledTimes(count);
    if (material.kind !== "material") throw new Error("Test material type.");
    await expect(media!.consume({ ...material, transaction: crypto.randomUUID(), material: Buffer.alloc(32, 8).toString("base64") })).rejects.toThrow("Conflicting participant material");
    await expect(media!.consume({ ...material, transaction: crypto.randomUUID(), proposalSequence: 2 })).rejects.toThrow();
    await expect(media!.consume({ ...receipt(test, 0, "key-ready"), reference: crypto.randomUUID() })).rejects.toThrow("Unbound participant readiness");
  });
  it("listener imports the full roster, emits readiness, captures nothing and does not reject a remote microphone using own empty grant", async () => {
    const test = setup([]); await open(test); await prepare(test); ownAck(test); await settle();
    await media!.consume(receipt(test, 0, "key-ready")); await media!.consume(receipt(test, 1, "key-ready"));
    expect(test.send.mock.calls.filter(([control]) => control.kind === "key-ready")).toHaveLength(2);
    await expect(media!.setSource("microphone", true)).rejects.toThrow("not granted");
    const subscribe = vi.fn(), publication = { source: "microphone", kind: "audio", mimeType: "audio/opus", isEncrypted: true, trackInfo: { encryption: 1 }, setSubscribed: subscribe };
    harness.rooms[0].events.get("trackPublished")!(publication, { identity: test.peers[0].participantIdentity }); await settle(); expect(subscribe).not.toHaveBeenCalled();
    ack(harness.rooms[0].worker, test.peers[0].participantIdentity); await settle(); expect(subscribe).toHaveBeenCalledExactlyOnceWith(true);
    expect(harness.rooms[0].localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled(); expect(harness.rooms[0].localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });
  it("a stale token completion never creates/connects a Room and the original ten-second keying deadline never resets", async () => {
    const test = setup(), pending = gate<Awaited<ReturnType<typeof test.token>>>(); test.token.mockImplementation(() => pending.promise);
    await open(test); await prepare(test); expect(test.token).toHaveBeenCalledOnce();
    const grant = await setup().token(); test.retire(); media!.fence(); pending.resolve(grant); await settle(); expect(harness.rooms).toHaveLength(0);
    const other = setup(); await open(other); await vi.advanceTimersByTimeAsync(10000); expect(other.fatal).toHaveBeenCalledExactlyOnceWith("media-keying-expired");
  });
  it.each([
    { source: "unknown", kind: "audio", mimeType: "audio/opus", isEncrypted: true, encryption: 1 },
    { source: "camera", kind: "audio", mimeType: "video/vp8", isEncrypted: true, encryption: 1 },
    { source: "camera", kind: "video", mimeType: "video/h264", isEncrypted: true, encryption: 1 },
    { source: "microphone", kind: "audio", mimeType: "audio/opus", isEncrypted: false, encryption: 0 },
    { source: "microphone", kind: "audio", mimeType: "audio/opus", isEncrypted: true, encryption: 2 },
  ])("refuses unsupported remote publication before subscribe: %j", async input => {
    const test = setup(); await open(test); await prepare(test); const subscribed = vi.fn();
    harness.rooms[0].events.get("trackPublished")!({ ...input, trackInfo: { encryption: input.encryption }, setSubscribed: subscribed }, { identity: test.peers[0].participantIdentity }); await settle();
    expect(test.fatal).toHaveBeenCalledOnce(); expect(subscribed).not.toHaveBeenCalledWith(true);
  });
  it("fence synchronously disconnects and a late capture is stopped without resurrection", async () => {
    const test = setup(); await open(test); await prepare(test); ownAck(test); await settle();
    await media!.consume(receipt(test, 0, "key-ready")); await media!.consume(receipt(test, 1, "key-ready"));
    const capture = gate<{ track: { stop(): void; mediaStreamTrack: { stop(): void } } }>(), stop = vi.fn();
    harness.rooms[0].localParticipant.setMicrophoneEnabled.mockImplementation(() => capture.promise);
    const result = media!.setSource("microphone", true).catch(error => error); media!.fence();
    expect(harness.rooms[0].disconnect).toHaveBeenCalled(); capture.resolve({ track: { stop, mediaStreamTrack: { stop } } });
    expect(await result).toBeInstanceOf(Error); expect(stop).toHaveBeenCalledOnce();
  });
  it("unknown/stale worker ACK and wrong key/index fail closed; identical SDK key resubmission remains valid", async () => {
    const { StrictVoiceWorker } = await import("@/lib/voice/strict-worker");
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits", "deriveKey"]);
    for (const change of [{ participantIdentity: "other", key, keyIndex: 0 }, { participantIdentity: "self", key, keyIndex: 1 }, { participantIdentity: "self", key: {}, keyIndex: 0 }]) {
      const failed = vi.fn(), worker = new StrictVoiceWorker(new URL("https://example.test/worker"), ["self"], failed, { ownIdentity: "self", expected: new Map([["self", key]]) });
      worker.postMessage({ kind: "setKey", data: change }); expect(failed).toHaveBeenCalledOnce();
      ack(worker, "self"); await expect(worker.waitUntilEnabled("self")).rejects.toThrow();
    }
    const failed = vi.fn(), worker = new StrictVoiceWorker(new URL("https://example.test/worker"), ["self"], failed, { ownIdentity: "self", expected: new Map([["self", key]]) });
    worker.postMessage({ kind: "setKey", data: { participantIdentity: "self", key, keyIndex: 0 } }); worker.postMessage({ kind: "setKey", data: { participantIdentity: "self", key, keyIndex: 0 } }); ack(worker, "self");
    await worker.waitUntilEnabled("self"); expect(failed).not.toHaveBeenCalled(); worker.terminate();
  });
  it("latest valid call authority permits established media beyond JWT join expiry; signal-only reconnect stays terminal", async () => {
    const test = setup(); await open(test); await prepare(test); ownAck(test); await settle();
    await media!.consume(receipt(test, 0, "key-ready")); await media!.consume(receipt(test, 1, "key-ready"));
    // The bridge models a renewed authoritative lease; JWT itself is never extended.
    await vi.advanceTimersByTimeAsync(31000); await media!.setSource("microphone", true);
    expect(test.fatal).not.toHaveBeenCalled();
    harness.rooms[0].events.get("signalReconnecting")!();
    expect(test.fatal).toHaveBeenCalledExactlyOnceWith("media-signal-reconnecting");
    await expect(media!.setSource("microphone", true)).rejects.toThrow("fenced");
    ack(harness.rooms[0].worker, test.context.self.participantIdentity);
    await expect(media!.setSource("microphone", true)).rejects.toThrow("fenced");
  });
});
