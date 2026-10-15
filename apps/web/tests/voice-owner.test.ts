import { createHash, randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceCryptoOwner, VoiceGenerationInterrupted, type VoiceOwnerTransport } from "../src/lib/voice/crypto-owner";
import { acquireVoiceOwnerGuard, releaseUnusedVoiceOwnerGuard } from "../src/lib/voice/owner-guard";
import { validateVoiceOwnerControl, voiceControlParty, VOICE_CONTROL_EVENT } from "../src/lib/voice/owner-control";
import { OwnerUnitPeer, OwnerUnitWire } from "./fixtures/voice-owner-peer";
import { VOICE_LIMITS, type VoiceSnapshot } from "../src/lib/voice/contracts";

function locks() {
  const held = new Set<string>();
  vi.stubGlobal("navigator", { locks: { async request(name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) { if (held.has(name)) return callback(null); held.add(name); try { await callback({ name }); } finally { held.delete(name); } } } });
}
function snapshot(): VoiceSnapshot {
  const callId = randomUUID(), memberId = randomUUID(), joinNonce = randomUUID(), voiceDeviceId = randomUUID(), userId = randomUUID();
  const voiceUserId = `@voice_${callId}_${memberId}:opendiscord.local`, participantIdentity = `v1:${memberId}`;
  return { callId, memberId, joinNonce, voiceDeviceId, voiceUserId, participantIdentity, generation: 1, channelId: randomUUID(), serverTime: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), removals: [], members: [{ memberId, joinNonce, voiceDeviceId, voiceUserId, participantIdentity, userId, anchorDeviceId: randomUUID(), displayName: "Owner unit fixture", state: "waiting" }] };
}
/** Small owner-unit transport only: actual own uploads/counts, current own query and signature storage.
 * It is deliberately not the product service and gives no service/protocol acceptance. */
function unitTransport(): VoiceOwnerTransport {
  let device: Record<string, unknown> | undefined;
  let signing: Record<string, unknown> = {};
  const prekeys = new Map<string, unknown>();
  return async ({ request }) => {
    if (request.kind === "upload") {
      if (request.body.device_keys) device = request.body.device_keys as Record<string, unknown>;
      for (const [id, value] of Object.entries(request.body.one_time_keys ?? {})) prekeys.set(id, value);
      return { one_time_key_counts: { signed_curve25519: prekeys.size } };
    }
    if (request.kind === "signing") { signing = request.body; return {}; }
    if (request.kind === "signatures") return { failures: {} };
    if (request.kind === "query") {
      const user = device?.user_id as string;
      return { device_keys: device ? { [user]: { [device.device_id as string]: device } } : {}, master_keys: signing.master_key ? { [user]: signing.master_key } : {}, self_signing_keys: signing.self_signing_key ? { [user]: signing.self_signing_key } : {}, user_signing_keys: signing.user_signing_key ? { [user]: signing.user_signing_key } : {}, failures: {} };
    }
    if (request.kind === "sync") return { cursor: "0", events: [], oneTimeKeys: { signed_curve25519: prekeys.size }, unusedFallbackKeys: [] };
    if (request.kind === "ack") return {};
    throw new Error("Unsupported owner unit request.");
  };
}
async function pair() {
  locks();
  const current = snapshot(), base = snapshot().members[0];
  const other = { ...base, voiceUserId: `@voice_${current.callId}_${base.memberId}:opendiscord.local` };
  current.members.push(other);
  const remote = { ...current, memberId: other.memberId, joinNonce: other.joinNonce, voiceUserId: other.voiceUserId, voiceDeviceId: other.voiceDeviceId, participantIdentity: other.participantIdentity };
  const wire = new OwnerUnitWire(current), onFence = vi.fn(), lifetime = new AbortController();
  const owner = await VoiceCryptoOwner.create({ accountId: current.members[0].userId, guard: await acquireVoiceOwnerGuard(current.members[0].userId), snapshot: current, lifetime: { signal: lifetime.signal, assertCurrent() {} }, transport: wire.port(current.memberId), onFence });
  const peer = await OwnerUnitPeer.create(remote, wire.port(other.memberId));
  return { owner, peer, current, other, wire, onFence, lifetime };
}
async function verify(value: Awaited<ReturnType<typeof pair>>, admit = true) {
  const { owner, peer, current, other } = value;
  await peer.query();
  const handle = await owner.requestVerification(other.memberId); await peer.receive();
  const state = (await owner.verificationStates()).find(state => state.handle === handle)!;
  const request = peer.machine.getVerificationRequest(new C.UserId(current.voiceUserId), state.flowId);
  if (!request) throw new Error("Missing unit peer SAS request.");
  const ready = request.acceptWithMethods([C.VerificationMethod.SasV1]); if (!ready) throw new Error("Missing unit ready.");
  await peer.out(ready); await owner.receive();
  await owner.verificationStep(handle, "start"); await peer.receive();
  const sas = request.getVerification(); if (!(sas instanceof C.Sas)) throw new Error("Missing peer SAS.");
  const accepted = sas.accept(); if (accepted) await peer.out(accepted);
  await owner.receive(); await peer.receive(); await owner.receive();
  const ownerState = (await owner.verificationStates()).find(state => state.handle === handle)!;
  expect(ownerState.emojiIndices).toEqual(Array.from(sas.emojiIndex()!));
  await owner.verificationStep(handle, "confirm");
  for (const output of await sas.confirm()) await peer.out(output);
  await owner.receive(); await peer.receive(); await owner.receive(); await peer.receive();
  await owner.query(current.members.map(member => member.memberId)); await peer.query();
  expect((await owner.verificationStates()).find(state => state.handle === handle)?.done).toBe(true);
  if (admit) await owner.admit(other.memberId);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("unreachable serial voice owner", () => {
  it("requires an actually held one-use account lock and releases only after native cleanup", async () => {
    locks(); const current = snapshot(), accountId = current.members[0].userId, onFence = vi.fn();
    const guard = await acquireVoiceOwnerGuard(accountId);
    await expect(acquireVoiceOwnerGuard(accountId)).rejects.toThrow("already held");
    await expect(VoiceCryptoOwner.create({ accountId, guard: { accountId }, snapshot: current, lifetime: { signal: new AbortController().signal, assertCurrent() {} }, transport: unitTransport(), onFence })).rejects.toThrow("capability");
    const owner = await VoiceCryptoOwner.create({ accountId, guard, snapshot: current, lifetime: { signal: new AbortController().signal, assertCurrent() {} }, transport: unitTransport(), onFence });
    try {
      await expect(VoiceCryptoOwner.create({ accountId, guard, snapshot: current, lifetime: { signal: new AbortController().signal, assertCurrent() {} }, transport: unitTransport(), onFence })).rejects.toThrow("capability");
      expect(await owner.receive()).toEqual([]);
    } finally { const closed = owner.close(); expect(onFence).toHaveBeenCalledWith("closed"); await closed; }
    const next = await acquireVoiceOwnerGuard(accountId); await releaseUnusedVoiceOwnerGuard(next);
  });
  it("keeps native DM keys unchanged, synchronously fences transition and refuses lifetime resurrection", async () => {
    locks(); await C.initAsync();
    const dm = await C.OlmMachine.initialize(new C.UserId(`@dm_owner_unit_${randomUUID()}:opendiscord.local`), new C.DeviceId(randomUUID()), undefined, undefined, { debug() {}, info() {}, warn() {}, error() {} });
    const room = new C.RoomId(`!owner_dm_history_${randomUUID()}:opendiscord.local`);
    await dm.shareRoomKey(room, [], new C.EncryptionSettings());
    const history = { msgtype: "m.text", body: "Independent owner unit DM history" };
    const encryptedHistory = { type: "m.room.encrypted", event_id: `$${randomUUID()}`, sender: dm.userId.toString(), origin_server_ts: Date.now(), content: JSON.parse(await dm.encryptRoomEvent(room, "m.room.message", JSON.stringify(history))) };
    const decryptHistory = async () => JSON.parse((await dm.decryptRoomEvent(JSON.stringify(encryptedHistory), room, new C.DecryptionSettings(C.TrustRequirement.Untrusted))).event).content;
    const baseline = async () => ({ keys: [dm.identityKeys.ed25519.toBase64(), dm.identityKeys.curve25519.toBase64()], counts: (await dm.roomKeyCounts()).total, trust: (await dm.getIdentity(dm.userId))?.isVerified() ?? false, flows: dm.getVerificationRequests(dm.userId).map(flow => flow.flowId), outgoing: (await dm.outgoingRequests()).map(request => ({ type: request.type, digest: createHash("sha256").update(JSON.stringify(JSON.parse(request.body))).digest("hex") })).sort((a, b) => a.type - b.type || a.digest.localeCompare(b.digest)) });
    const before = await baseline();
    expect(await decryptHistory()).toEqual(history);
    expect(await baseline()).toEqual(before);
    const current = snapshot(), accountId = current.members[0].userId, onFence = vi.fn(); let alive = true;
    const owner = await VoiceCryptoOwner.create({ accountId, guard: await acquireVoiceOwnerGuard(accountId), snapshot: current, lifetime: { signal: new AbortController().signal, assertCurrent() { if (!alive) throw new Error("Expired lifetime."); } }, transport: unitTransport(), onFence });
    try {
      const transition = owner.transition({ ...current, generation: 2 });
      expect(onFence).toHaveBeenCalledWith("generation-transition"); await transition;
      expect(await owner.receive()).toEqual([]);
      expect(await baseline()).toEqual(before);
      expect(await decryptHistory()).toEqual(history);
      alive = false; await expect(owner.flush()).rejects.toThrow("Expired lifetime");
      expect(onFence).toHaveBeenCalledWith("lifetime-lost");
      alive = true; await expect(owner.flush()).rejects.toThrow("closed");
    } finally { await owner.close(); dm.close(); }
  });
  for (const changed of ["generation", "epochId", "audience"] as const) it(`rejects a separate ${changed}-only control mismatch without effects`, () => {
    const current = snapshot(), party = voiceControlParty(current.members[0]), epochId = randomUUID();
    const valid = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "prepared", callId: current.callId, generation: current.generation, epochId, sender: party, recipient: party, publisher: party, audience: [party], keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID() };
    expect(validateVoiceOwnerControl(valid, current, epochId, [party])).toEqual(valid);
    const invalid = { ...valid, [changed]: changed === "generation" ? 2 : changed === "epochId" ? randomUUID() : [] };
    expect(() => validateVoiceOwnerControl(invalid, current, epochId, [party])).toThrow();
  });
  for (const changed of ["generation", "epochId", "audience"] as const) it(`rejects genuinely decrypted ${changed}-only stale control without admission or receipt effects`, async () => {
    const value = await pair();
    try {
      await verify(value);
      const { current, other, owner, peer, wire } = value;
      const epochId = randomUUID(), parties = current.members.map(voiceControlParty).sort((a, b) => a.memberId.localeCompare(b.memberId));
      await owner.setControlContext(epochId, current.members.map(member => member.memberId));
      const good = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: current.callId, generation: current.generation, epochId, sender: voiceControlParty(other), recipient: voiceControlParty(current.members[0]), publisher: voiceControlParty(other), audience: parties, keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, 5).toString("base64") };
      // Positive genuine decryption first proves native sender verification and full Olm metadata parsing.
      await peer.encrypt(current.members[0], good);
      expect(await owner.receive()).toEqual([good]);
      const invalid = { ...good, transaction: randomUUID(), [changed]: changed === "generation" ? current.generation + 1 : changed === "epochId" ? randomUUID() : [voiceControlParty(other)] };
      await peer.encrypt(current.members[0], invalid);
      const before = wire.sent.length;
      await expect(owner.receive()).rejects.toThrow();
      expect(wire.sent.slice(before).filter(entry => entry.request.kind === "send")).toEqual([]);
      expect(value.onFence).toHaveBeenCalledWith("native-or-schema-failure");
      await expect(owner.admit(other.memberId)).rejects.toThrow("closed");
    } finally { await value.owner.close(); value.peer.close(); }
  });
  it("deduplicates concurrent native completion and late old-generation success after explicit retirement", async () => {
    const value = await pair();
    const original = C.OlmMachine.prototype.markRequestAsSent;
    const completions: string[] = [];
    const completionArrived = deferred<void>(), completionRelease = deferred<void>();
    let targetId: string | undefined;
    vi.spyOn(C.OlmMachine.prototype, "markRequestAsSent").mockImplementation(async function(this: C.OlmMachine, id, type, response) {
      completions.push(id);
      if (id === targetId) { completionArrived.resolve(); await completionRelease.promise; }
      return original.call(this, id, type, response);
    });
    try {
      const arrived = deferred<void>(), release = deferred<void>(), sendReturned = deferred<void>();
      value.wire.pause = async entry => { if (entry.memberId === value.current.memberId && entry.request.kind === "send" && entry.request.eventType === "m.key.verification.request") { arrived.resolve(); await release.promise; sendReturned.resolve(); } };
      const requested = value.owner.requestVerification(value.other.memberId);
      const requestedFailure = expect(requested).rejects.toThrow("generation interrupted");
      await arrived.promise;
      const send = [...value.wire.sent].reverse().find(entry => entry.request.kind === "send")!;
      if (!("nativeRequestId" in send.request)) throw new Error("Missing native ID.");
      const id = send.request.nativeRequestId; targetId = id;
      const transition = value.owner.transition({ ...value.current, generation: 2 });
      await completionArrived.promise;
      // Late send success arrives while real native retirement completion is awaiting its barrier.
      release.resolve(); await sendReturned.promise;
      completionRelease.resolve(); await transition;
      expect(value.onFence).toHaveBeenCalledWith("generation-transition");
      const retired = value.wire.sent.filter(entry => entry.request.kind === "retire");
      expect(retired.some(entry => "nativeRequestId" in entry.request && entry.request.nativeRequestId === id)).toBe(true);
      await requestedFailure;
      expect(completions.filter(value => value === id)).toHaveLength(1);
      expect(retired.every(entry => entry.binding.expectedGeneration === 2)).toBe(true);
      value.wire.pause = undefined;
      const fresh = await value.owner.requestVerification(value.other.memberId);
      expect(fresh).toBeTruthy();
      expect(value.wire.sent.at(-1)?.request.kind).toBe("send");
    } finally { await value.owner.close(); value.peer.close(); }
  });
  it("fences lifetime abort immediately and rejects late transport work before releasing the Web Lock", async () => {
    const value = await pair();
    try {
      value.lifetime.abort();
      expect(value.onFence).toHaveBeenCalledWith("lifetime-lost");
      await expect(value.owner.receive()).rejects.toThrow("closed");
      await value.owner.close();
      const guard = await acquireVoiceOwnerGuard(value.current.members[0].userId); await releaseUnusedVoiceOwnerGuard(guard);
    } finally { await value.owner.close(); value.peer.close(); }
  });

  it("does not commit an admission paused in real native getDevice across a generation fence", async () => {
    const value = await pair();
    try {
      await verify(value, false);
      const arrived = deferred<void>(), release = deferred<void>(), original = C.OlmMachine.prototype.getDevice;
      let pause = true;
      vi.spyOn(C.OlmMachine.prototype, "getDevice").mockImplementation(async function(this: C.OlmMachine, ...args) {
        const device = await original.apply(this, args);
        if (pause && this.userId.toString() === value.current.voiceUserId && args[0].toString() === value.other.voiceUserId) { pause = false; arrived.resolve(); await release.promise; }
        return device;
      });
      const admission = value.owner.admit(value.other.memberId);
      await arrived.promise;
      const transition = value.owner.transition({ ...value.current, generation: 2 });
      expect(value.onFence).toHaveBeenCalledWith("generation-transition");
      release.resolve();
      await expect(admission).rejects.toThrow("generation interrupted"); await transition;
      // No stale admission was committed, despite retained genuine completed native trust.
      await expect(value.owner.setControlContext(randomUUID(), value.current.members.map(member => member.memberId))).rejects.toThrow("admission required");
    } finally { await value.owner.close(); value.peer.close(); }
  });
  it("retains exact unchanged prior explicit admission and completed native trust through generation and epoch drains", async () => {
    const value = await pair();
    try {
      await verify(value);
      await value.owner.transition({ ...value.current, generation: 2 });
      await value.owner.setControlContext(randomUUID(), value.current.members.map(member => member.memberId));
      await value.owner.setControlContext(randomUUID(), value.current.members.map(member => member.memberId));
      expect(value.onFence).toHaveBeenCalledWith("audience-context-change");
    } finally { await value.owner.close(); value.peer.close(); }
  });

  it("closes on malformed sync response instead of retaining a schema-failed owner", async () => {
    locks(); const current = snapshot(), accountId = current.members[0].userId, onFence = vi.fn(), port = unitTransport();
    const owner = await VoiceCryptoOwner.create({ accountId, guard: await acquireVoiceOwnerGuard(accountId), snapshot: current, lifetime: { signal: new AbortController().signal, assertCurrent() {} }, transport: input => input.request.kind === "sync" ? Promise.resolve({ cursor: "0", events: "invalid" }) : port(input), onFence });
    try {
      await expect(owner.receive()).rejects.toThrow();
      expect(onFence).toHaveBeenCalledWith("native-or-schema-failure");
      await expect(owner.flush()).rejects.toThrow("closed");
    } finally { await owner.close(); }
  });
  it("closes an unexpected native failure without affecting an independent native peer", async () => {
    const value = await pair();
    const before = value.peer.machine.identityKeys.ed25519.toBase64(), original = C.OlmMachine.prototype.outgoingRequests;
    vi.spyOn(C.OlmMachine.prototype, "outgoingRequests").mockImplementation(async function(this: C.OlmMachine) {
      const output = await original.call(this);
      if (this.userId.toString() === value.current.voiceUserId) throw new Error("Unexpected native operation failure.");
      return output;
    });
    try {
      await expect(value.owner.flush()).rejects.toThrow("Unexpected native operation failure");
      expect(value.onFence).toHaveBeenCalledWith("native-or-schema-failure");
      expect(value.peer.machine.identityKeys.ed25519.toBase64()).toBe(before);
      await value.peer.flush();
    } finally { await value.owner.close(); value.peer.close(); }
  });
  it("closes native ownership while old HTTP is pending and fences its late response", async () => {
    const value = await pair();
    const arrived = deferred<void>(), release = deferred<void>();
    try {
      value.wire.pause = async entry => { if (entry.memberId === value.current.memberId && entry.request.kind === "query") { arrived.resolve(); await release.promise; } };
      const pending = value.owner.query([value.current.memberId, value.other.memberId]);
      const failed = expect(pending).rejects.toThrow("closed");
      await arrived.promise;
      value.lifetime.abort(); expect(value.onFence).toHaveBeenCalledWith("lifetime-lost");
      await value.owner.close();
      const guard = await acquireVoiceOwnerGuard(value.current.members[0].userId);
      release.resolve(); await failed;
      await releaseUnusedVoiceOwnerGuard(guard);
    } finally { release.resolve(); await value.owner.close(); value.peer.close(); }
  });

  it("retires registered old work after an intentionally interrupted actual send commit", async () => {
    const value = await pair();
    try {
      let interrupted = false;
      value.wire.pause = async entry => {
        if (!interrupted && entry.memberId === value.current.memberId && entry.request.kind === "send") { interrupted = true; throw new VoiceGenerationInterrupted(); }
      };
      await expect(value.owner.requestVerification(value.other.memberId)).rejects.toBeInstanceOf(VoiceGenerationInterrupted);
      const sent = value.wire.sent.find(entry => entry.request.kind === "send")!;
      expect(value.onFence).not.toHaveBeenCalled();
      await value.owner.transition({ ...value.current, generation: 2 });
      const retired = value.wire.sent.find(entry => entry.request.kind === "retire" && "nativeRequestId" in sent.request && entry.request.nativeRequestId === sent.request.nativeRequestId);
      expect(retired).toBeDefined();
      expect(value.wire.sent.filter(entry => entry.request.kind === "send")).toHaveLength(1);
      // The original send already committed. Retirement reports only its own zero-enqueue operation.
      expect(retired?.binding.expectedGeneration).toBe(2);
    } finally { await value.owner.close(); value.peer.close(); }
  });
  it("fails closed on genuine native output first observed at transition instead of backdating its generation", async () => {
    const value = await pair();
    const arrived = deferred<void>(), release = deferred<void>();
    try {
      await value.peer.query();
      const handle = await value.owner.requestVerification(value.other.memberId); await value.peer.receive();
      const state = (await value.owner.verificationStates())[0];
      const request = value.peer.machine.getVerificationRequest(new C.UserId(value.current.voiceUserId), state.flowId);
      if (!request) throw new Error("Missing unit request.");
      const ready = request.acceptWithMethods([C.VerificationMethod.SasV1]); if (!ready) throw new Error("Missing unit ready.");
      await value.peer.out(ready); await value.owner.receive();
      await value.owner.verificationStep(handle, "start"); await value.peer.receive();
      const sas = request.getVerification(); if (!(sas instanceof C.Sas)) throw new Error("Missing unit SAS.");
      const accepted = sas.accept(); if (accepted) await value.peer.out(accepted);
      value.wire.pause = async entry => { if (entry.memberId === value.current.memberId && entry.request.kind === "ack") { arrived.resolve(); await release.promise; } };
      // Processing native accept produces a native key output, but HTTP ACK is held before normal flush observes it.
      const receive = value.owner.receive(), interrupted = expect(receive).rejects.toThrow();
      await arrived.promise;
      await expect(value.owner.transition({ ...value.current, generation: 2 })).rejects.toThrow("Unclassifiable first-observed transition output");
      expect(value.onFence).toHaveBeenCalledWith("native-or-schema-failure");
      release.resolve(); await interrupted;
      expect(value.wire.sent.filter(entry => entry.request.kind === "retire")).toEqual([]);
    } finally { release.resolve(); await value.owner.close(); value.peer.close(); }
  });

  for (const invalid of ["event-bytes", "event-utf8-bytes", "event-count", "key-count", "key-map", "fallback", "envelope", "event-type", "content"] as const) it(`rejects bounded-sync ${invalid} before any native receive and releases ownership`, async () => {
    locks();
    const current = snapshot(), base = snapshot().members[0], other = { ...base, voiceUserId: `@voice_${current.callId}_${base.memberId}:opendiscord.local` };
    current.members.push(other);
    const accountId = current.members[0].userId, onFence = vi.fn(), port = unitTransport();
    const event = { sender: other.voiceUserId, type: "m.key.verification.cancel", content: { transaction_id: "bounded-fixture", code: "m.user", reason: "Fixture cancellation" } };
    const batch = { cursor: "0", events: [event] as unknown[], oneTimeKeys: { signed_curve25519: 0 } as Record<string, number>, unusedFallbackKeys: [] as string[] };
    if (invalid === "event-bytes") event.content.reason = "x".repeat(VOICE_LIMITS.requestBytes + 257);
    if (invalid === "event-utf8-bytes") {
      event.content.reason = "🦊".repeat(2200);
      expect(JSON.stringify(event).length).toBeLessThan(VOICE_LIMITS.requestBytes + 256);
      expect(Buffer.byteLength(JSON.stringify(event))).toBeGreaterThan(VOICE_LIMITS.requestBytes + 256);
    }
    if (invalid === "event-count") batch.events = Array.from({ length: VOICE_LIMITS.syncBatch + 1 }, () => event);
    if (invalid === "key-count") batch.oneTimeKeys.signed_curve25519 = VOICE_LIMITS.prekeys + 1;
    if (invalid === "key-map") batch.oneTimeKeys = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`unknown_${index}`, 1]));
    if (invalid === "fallback") batch.unusedFallbackKeys = ["unsupported_algorithm"];
    if (invalid === "envelope") batch.events = [{ ...event, unexpected: "outside stored service envelope" }];
    if (invalid === "event-type") batch.events = [{ ...event, type: "m.room.message" }];
    if (invalid === "content") batch.events = [{ sender: other.voiceUserId, type: event.type }];
    const owner = await VoiceCryptoOwner.create({ accountId, guard: await acquireVoiceOwnerGuard(accountId), snapshot: current, lifetime: { signal: new AbortController().signal, assertCurrent() {} }, transport: input => input.request.kind === "sync" ? Promise.resolve(batch) : port(input), onFence });
    // The public spy is a hard tripwire: RED must never send oversized data into native code.
    const nativeReceive = vi.spyOn(C.OlmMachine.prototype, "receiveSyncChanges").mockImplementation(async () => { throw new Error("Pre-native validation tripwire."); });
    try {
      const rejected = owner.receive();
      await expect(rejected).rejects.toThrow();
      expect(nativeReceive).not.toHaveBeenCalled();
      if (invalid === "event-bytes" || invalid === "event-utf8-bytes") await expect(rejected).rejects.toThrow("Voice sync event byte limit");
      expect(onFence).toHaveBeenCalledWith("native-or-schema-failure");
      await expect(owner.flush()).rejects.toThrow("closed");
      await owner.close();
      const next = await acquireVoiceOwnerGuard(accountId); await releaseUnusedVoiceOwnerGuard(next);
    } finally { await owner.close(); }
  });

});
