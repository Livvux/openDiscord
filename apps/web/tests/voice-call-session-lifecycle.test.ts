import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession, VoiceRetirementConflict } from "@/lib/voice/call-session";
import type { VoiceOwnerOptions, VoiceProductOwnerPort } from "@/lib/voice/crypto-owner";
import { VoiceContextProposal, VoiceContextRejected } from "@/lib/voice/epoch-agreement";
import { VOICE_CONTROL_EVENT, voiceControlParty, type VoiceOwnerControl } from "@/lib/voice/owner-control";
import type { VoiceSnapshot } from "@/lib/voice/contracts";
import type { InstalledVoiceMediaContext, VoiceMediaBridge } from "@/lib/voice/media-session";

const native = vi.hoisted(() => ({ options: undefined as VoiceOwnerOptions | undefined, port: undefined as VoiceProductOwnerPort | undefined }));
const mediaEffects = vi.hoisted(() => ({ consume: vi.fn(async (_control: VoiceOwnerControl) => {}), fence: vi.fn(), contexts: [] as InstalledVoiceMediaContext[], bridges: [] as VoiceMediaBridge[] }));
// Control adapter ordering only. Real worker/media acceptance is in the browser suite.
vi.mock("@/lib/voice/media-session", () => ({ MediaSession: class {
  constructor(context: InstalledVoiceMediaContext, bridge: VoiceMediaBridge) { mediaEffects.contexts.push(context); mediaEffects.bridges.push(bridge); }
  start() {} consume = mediaEffects.consume; fence = mediaEffects.fence;
} }));
vi.mock("@/lib/voice/crypto-owner", () => ({ createVoiceProductOwner: async (options: VoiceOwnerOptions) => { native.options = options; return native.port; }, VoiceGenerationInterrupted: class extends Error {} }));
const callId = crypto.randomUUID(), memberId = crypto.randomUUID(), channelId = crypto.randomUUID();
let deviceId = crypto.randomUUID(), nonce = crypto.randomUUID();
function snapshot(generation = 1, duration = 30_000): VoiceSnapshot {
  const self = { memberId, userId: "account", anchorDeviceId: crypto.randomUUID(), voiceDeviceId: deviceId, joinNonce: nonce, voiceUserId: `@voice_${callId}_${memberId}:opendiscord.local`, participantIdentity: `v1:${memberId}`, displayName: "Account", state: "active" as const };
  return { callId, channelId, generation, memberId, joinNonce: nonce, voiceUserId: self.voiceUserId, voiceDeviceId: deviceId, participantIdentity: self.participantIdentity, members: [self], removals: [], serverTime: new Date(0).toISOString(), leaseExpiresAt: new Date(duration).toISOString() };
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let call: CallSession | undefined;
beforeEach(() => {
  mediaEffects.consume.mockClear(); mediaEffects.fence.mockClear();
  mediaEffects.contexts.length = 0; mediaEffects.bridges.length = 0;
  native.options = undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const held = new Set<string>();
  vi.stubGlobal("navigator", { locks: { async request(name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) { if (held.has(name)) return callback(null); held.add(name); try { await callback({ name }); } finally { held.delete(name); } } } });
  vi.stubGlobal("window", { localStorage: { getItem: () => JSON.stringify({ id: crypto.randomUUID(), secret: "a".repeat(64), storeKey: "long-enough-development-store-key" }) } });
  native.port = { query: vi.fn(async () => {}), flush: vi.fn(async () => {}), requestVerification: vi.fn(async () => "flow"), verificationStep: vi.fn(async () => {}), verificationStates: vi.fn(async () => []), admit: vi.fn(async () => {}), transition: vi.fn(async () => {}), selectAudience: vi.fn(async () => {}), createContextOffer: vi.fn(), sendContextControl: vi.fn(async () => undefined), receiveAgreement: vi.fn(async () => []), stageOfferedContext: vi.fn(async () => {}), acceptContextControl: vi.fn(async () => false), retainPendingMaterial: vi.fn(async () => {}), installContext: vi.fn(async () => []), contextAgreementComplete: vi.fn(async () => false), sendControl: vi.fn(async () => {}), close: vi.fn(async () => {}) };
});
afterEach(async () => { await call?.close(); call = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
const options = { accountId: "account", sessionId: "session", channelId, consent: true as const, assertSessionCurrent() {} };
async function installCurrent() {
  const party = voiceControlParty(snapshot().members[0]), reference = crypto.randomUUID();
  const proposal = new VoiceContextProposal({ version: 1, purpose: VOICE_CONTROL_EVENT, kind: "context-offer", callId, generation: 1, epochId: crypto.randomUUID(), sequence: 1, reference, transaction: reference, sender: party, recipient: party, leader: party, audience: [party] });
  vi.mocked(native.port!.createContextOffer).mockResolvedValue({ ref: Object.freeze({ kind: "context-offer" }), proposal });
  vi.mocked(native.port!.contextAgreementComplete).mockResolvedValue(true);
  await call!.confirmFullRoster(); return proposal;
}
const dispatch = (generation: number) => native.options!.transport({ binding: { callId, memberId, joinNonce: nonce, expectedGeneration: generation }, request: { kind: "sync" }, signal: native.options!.lifetime.signal });
function fetcher(handle?: (action: string, generation: number) => Promise<Response> | Response): typeof fetch {
  return async (_path, init) => { const body = JSON.parse(String(init?.body)); if (body.action === "join") { nonce = body.input.joinNonce; deviceId = body.input.voiceDeviceId; return Response.json(snapshot()); } return handle?.(body.action, body.input.expectedGeneration) ?? Response.json(body.action === "heartbeat" ? snapshot() : body.action === "leave" ? { removals: [] } : { cursor: "0", events: [], oneTimeKeys: { signed_curve25519: 0 }, unusedFallbackKeys: [] }); };
}
describe("CallSession deterministic lifetime adapter (native port mocked, no native acceptance claim)", () => {
  it("private media handoff omits Owner/ref/secret, freezes exact installed context and fences before render observers", async () => {
    call = await CallSession.create({ ...options, fetch: fetcher() }); const proposal = await installCurrent();
    const context = mediaEffects.contexts[0], bridge = mediaEffects.bridges[0];
    expect(Object.keys(bridge).sort()).toEqual(["current", "fatal", "send", "token"]);
    expect(context).not.toHaveProperty("owner"); expect(context).not.toHaveProperty("secret"); expect(context).not.toHaveProperty("ref");
    expect(context).toMatchObject({ epochId: proposal.epochId, proposalSequence: proposal.sequence, reference: proposal.reference, deadline: 10000 });
    expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.snapshot.members)).toBe(true);
    call.subscribe(() => { expect(mediaEffects.fence).toHaveBeenCalled(); throw new Error("Broken render observer."); });
    native.options!.onFence("generation-transition");
    expect(() => bridge.current()).toThrow();
  });
  it("token409 follows discovery policy; same-generation is fatal and newer generation cannot retry the old bridge", async () => {
    let newer = false;
    call = await CallSession.create({ ...options, fetch: fetcher(action => action === "token" ? Response.json({ code: "conflict" }, { status: 409 }) : action === "heartbeat" ? Response.json(snapshot(newer ? 2 : 1)) : Response.json({ removals: [] })) });
    await installCurrent();
    await expect(mediaEffects.bridges[0].token()).rejects.toMatchObject({ code: "generation-conflict" });
    expect(call.getSnapshot().state).toBe("ended"); await call.close();
    newer = true;
    call = await CallSession.create({ ...options, fetch: fetcher(action => action === "token" ? Response.json({ code: "conflict" }, { status: 409 }) : action === "heartbeat" ? Response.json(snapshot(2)) : Response.json({ removals: [] })) });
    await installCurrent();
    const bridge = mediaEffects.bridges.at(-1)!;
    vi.mocked(native.port!.transition).mockImplementation(async () => { await expect(bridge.token()).rejects.toThrow(); });
    await expect(bridge.token()).rejects.toMatchObject({ code: "conflict" });
    expect(call.getSnapshot().generation).toBe(2); expect(() => bridge.current()).toThrow();
  });
  it("an already-issued token409 during native transition ends immediately without nested discovery", async () => {
    const response = gate<Response>(); let heartbeats = 0;
    call = await CallSession.create({ ...options, fetch: fetcher(action => {
      if (action === "token") return response.promise;
      if (action === "heartbeat") { heartbeats++; return Response.json(snapshot(2)); }
      if (action === "crypto") return Response.json({ code: "conflict" }, { status: 409 });
      return Response.json({ removals: [] });
    }) });
    await installCurrent(); const token = mediaEffects.bridges[0].token().catch(error => error);
    vi.mocked(native.port!.transition).mockImplementation(async () => {
      response.resolve(Response.json({ code: "conflict" }, { status: 409 }));
      expect(await token).toBeInstanceOf(VoiceRetirementConflict);
    });
    await expect(dispatch(1)).rejects.toThrow(); expect(heartbeats).toBe(1); expect(call.getSnapshot().state).toBe("ended");
  });
  it("does not gate successful target-generation retirement traffic on its own transition", async () => {
    let first = true;
    call = await CallSession.create({ ...options, fetch: fetcher((action) => {
      if (action === "heartbeat") return Response.json(snapshot(2));
      if (action === "crypto" && first) { first = false; return Response.json({ code: "conflict" }, { status: 409 }); }
      return Response.json({ cursor: "0", events: [], oneTimeKeys: { signed_curve25519: 0 }, unusedFallbackKeys: [] });
    }) });
    vi.mocked(native.port!.transition).mockImplementation(async () => { await dispatch(2); });
    await expect(dispatch(1)).rejects.toMatchObject({ code: "conflict" });
    expect(native.port!.transition).toHaveBeenCalledTimes(1); expect(call.getSnapshot().generation).toBe(2); expect(call.getSnapshot().state).not.toBe("ended");
  });
  it("any409 during transition throws retirement conflict immediately without discovery or a promise cycle", async () => {
    let heartbeats = 0, conflicts = false;
    vi.mocked(native.port!.query).mockImplementation(async () => { await dispatch(1); });
    call = await CallSession.create({ ...options, fetch: fetcher(action => {
      if (action === "heartbeat") { heartbeats++; return Response.json(snapshot(2)); }
      if (!conflicts) return Response.json({ cursor: "0", events: [], oneTimeKeys: { signed_curve25519: 0 }, unusedFallbackKeys: [] });
      return Response.json({ code: "conflict" }, { status: 409 });
    }) });
    expect(native.port!.query).toHaveBeenCalledTimes(1); expect(native.port!.transition).not.toHaveBeenCalled();
    conflicts = true;
    vi.mocked(native.port!.transition).mockImplementation(async () => { await expect(dispatch(2)).rejects.toBeInstanceOf(VoiceRetirementConflict); });
    await expect(dispatch(1)).rejects.toThrow();
    expect(heartbeats).toBe(1); expect(native.port!.transition).toHaveBeenCalledTimes(1); expect(call.getSnapshot().state).toBe("ended");
  });
  it("shares heartbeat discovery, holds old successes, and permits only one external transition", async () => {
    const discovery = gate<Response>(), drain = gate<void>();
    let heartbeatCount = 0, old = 0;
    call = await CallSession.create({ ...options, fetch: fetcher(action => {
      if (action === "heartbeat") { heartbeatCount++; return discovery.promise; }
      old++; return old <= 2 ? Response.json({ code: "conflict" }, { status: 409 }) : Response.json({ cursor: "0", events: [], oneTimeKeys: { signed_curve25519: 0 }, unusedFallbackKeys: [] });
    }) });
    vi.mocked(native.port!.transition).mockImplementation(() => drain.promise);
    const first = dispatch(1).catch(error => error), second = dispatch(1).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); expect(heartbeatCount).toBe(1);
    let delivered = false; const success = dispatch(1).then(() => { delivered = true; });
    discovery.resolve(Response.json(snapshot(2))); await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toBe(false); expect(native.port!.transition).toHaveBeenCalledTimes(1);
    drain.resolve(); await Promise.all([first, second, success]); expect(delivered).toBe(true);
  });
  it("bounds a hanging response gate and abort releases all pending callers", async () => {
    const discovery = gate<Response>();
    call = await CallSession.create({ ...options, fetch: fetcher(action => action === "heartbeat" ? discovery.promise : Response.json({ code: "conflict" }, { status: 409 })) });
    const pending = dispatch(1).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); await call.close("unmount");
    expect(await pending).toMatchObject({ code: "ended" }); expect(native.port!.close).toHaveBeenCalledTimes(1);
    discovery.resolve(Response.json(snapshot(2))); await vi.advanceTimersByTimeAsync(0);
    expect(native.port!.transition).not.toHaveBeenCalled();
  });
  it("context deadline starts before selection queue work and needs explicit fresh retry", async () => {
    call = await CallSession.create({ ...options, fetch: fetcher() });
    const selection = gate<void>(); vi.mocked(native.port!.selectAudience).mockImplementationOnce(() => selection.promise);
    const attempt = call.confirmFullRoster().catch(error => error);
    await vi.advanceTimersByTimeAsync(10_001); expect(call.getSnapshot().state).toBe("retry-required");
    selection.resolve(); expect(await attempt).toMatchObject({ code: "context-expired" }); expect(native.port!.createContextOffer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000); expect(native.port!.selectAudience).toHaveBeenCalledTimes(1);
  });
  it("accounts every HTTP request, reserves heartbeat slots, and never polls faster than one second or overlaps", async () => {
    let heartbeats = 0;
    vi.mocked(native.port!.query).mockImplementation(async () => { await dispatch(1); });
    call = await CallSession.create({ ...options, fetch: fetcher(action => {
      if (action === "heartbeat") { heartbeats++; return Response.json(snapshot()); }
      return Response.json({ cursor: "0", events: [], oneTimeKeys: { signed_curve25519: 0 }, unusedFallbackKeys: [] });
    }) });
    // Join + the real HTTP issued by the public query adapter +160ordinary requests.
    for (let i = 0; i < 160; i++) await dispatch(1);
    await vi.advanceTimersByTimeAsync(10_000); expect(heartbeats).toBe(1); expect(native.port!.receiveAgreement).not.toHaveBeenCalled();
    await expect(dispatch(1)).rejects.toMatchObject({ code: "budget-exhausted" });
  });
  it("synchronously fences the observable agreement while preserving legitimate stage/install capabilities", async () => {
    call = await CallSession.create({ ...options, fetch: fetcher() });
    const party = voiceControlParty(snapshot().members[0]), reference = crypto.randomUUID();
    const proposal = new VoiceContextProposal({ version: 1, purpose: VOICE_CONTROL_EVENT, kind: "context-offer", callId, generation: 1, epochId: crypto.randomUUID(), sequence: 1, reference, transaction: reference, sender: party, recipient: party, leader: party, audience: [party] });
    vi.mocked(native.port!.createContextOffer).mockResolvedValue({ ref: Object.freeze({ kind: "context-offer" }), proposal });
    vi.mocked(native.port!.contextAgreementComplete).mockResolvedValue(true);
    const observed: string[] = [];
    vi.mocked(native.port!.selectAudience).mockImplementation(async () => { native.options!.onFence("audience-selection-change"); observed.push(call!.getSnapshot().state); });
    vi.mocked(native.port!.stageOfferedContext).mockImplementation(async () => { native.options!.onFence("offered-context-change"); observed.push(call!.getSnapshot().state); });
    vi.mocked(native.port!.installContext).mockImplementation(async () => { native.options!.onFence("audience-context-change"); observed.push(call!.getSnapshot().state); return []; });
    await call.confirmFullRoster(); expect(call.getSnapshot().state).toBe("agreed");
    const revision = call.getSnapshot().fenceRevision;
    await call.confirmFullRoster(); expect(call.getSnapshot().state).toBe("agreed");
    expect(call.getSnapshot().fenceRevision).toBeGreaterThan(revision);
    expect(observed).toEqual(Array(6).fill("negotiating"));
    expect(native.port!.installContext).toHaveBeenCalledTimes(2);
  });
  it("a real typed lower-offer staging rejection leaves the installed view/fence/timer unchanged", async () => {
    call = await CallSession.create({ ...options, fetch: fetcher() });
    const party = voiceControlParty(snapshot().members[0]), reference = crypto.randomUUID();
    const proposal = new VoiceContextProposal({ version: 1, purpose: VOICE_CONTROL_EVENT, kind: "context-offer", callId, generation: 1, epochId: crypto.randomUUID(), sequence: 2, reference, transaction: reference, sender: party, recipient: party, leader: party, audience: [party] });
    vi.mocked(native.port!.createContextOffer).mockResolvedValue({ ref: Object.freeze({ kind: "context-offer" }), proposal });
    vi.mocked(native.port!.contextAgreementComplete).mockResolvedValue(true);
    await call.confirmFullRoster();
    const installed = call.getSnapshot();
    const seen: string[] = []; call.subscribe(() => seen.push(call!.getSnapshot().state));
    vi.mocked(native.port!.receiveAgreement).mockResolvedValueOnce([{ kind: "context", contextKind: "context-offer", senderId: memberId, proposal, ref: Object.freeze({ kind: "context-offer" }) }]);
    vi.mocked(native.port!.stageOfferedContext).mockRejectedValueOnce(new VoiceContextRejected("Lower voice leader sequence rejected."));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(call.getSnapshot()).toEqual(installed); expect(seen).not.toContain("negotiating"); expect(seen).not.toContain("ended");
    await vi.advanceTimersByTimeAsync(11_000);
    expect(call.getSnapshot().state).toBe("agreed"); expect(call.getSnapshot().fenceRevision).toBe(installed.fenceRevision);
    expect(native.port!.installContext).toHaveBeenCalledTimes(1);
    const material: VoiceOwnerControl = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId, generation: 1, epochId: proposal.epochId, proposalSequence: proposal.sequence, sender: party, recipient: party, publisher: party, audience: [party], keyId: crypto.randomUUID(), reference: crypto.randomUUID(), transaction: crypto.randomUUID(), material: Buffer.alloc(32, 1).toString("base64") };
    vi.mocked(native.port!.receiveAgreement).mockResolvedValueOnce([{ kind: "context", contextKind: "context-offer", senderId: memberId, proposal, ref: Object.freeze({ kind: "context-offer" }) }, { kind: "pending-material", ref: Object.freeze({ kind: "pending-material" }) }, { kind: "media", control: material }]);
    vi.mocked(native.port!.stageOfferedContext).mockRejectedValueOnce(new VoiceContextRejected("Retired voice proposal replay."));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native.port!.retainPendingMaterial).not.toHaveBeenCalled();
    expect(call.getSnapshot().state).toBe("agreed"); expect(mediaEffects.consume).toHaveBeenCalledExactlyOnceWith(material);
  });
  it.each([new Error("Voice leader sequence conflict."), new Error("Schema/native binding failure.")])("does not suppress current staging failures: %s", async failure => {
    call = await CallSession.create({ ...options, fetch: fetcher() });
    const party = voiceControlParty(snapshot().members[0]), reference = crypto.randomUUID();
    const proposal = new VoiceContextProposal({ version: 1, purpose: VOICE_CONTROL_EVENT, kind: "context-offer", callId, generation: 1, epochId: crypto.randomUUID(), sequence: 1, reference, transaction: reference, sender: party, recipient: party, leader: party, audience: [party] });
    vi.mocked(native.port!.createContextOffer).mockResolvedValue({ ref: Object.freeze({ kind: "context-offer" }), proposal });
    vi.mocked(native.port!.contextAgreementComplete).mockResolvedValue(true);
    await call.confirmFullRoster();
    vi.mocked(native.port!.receiveAgreement).mockResolvedValueOnce([{ kind: "context", contextKind: "context-offer", senderId: memberId, proposal, ref: Object.freeze({ kind: "context-offer" }) }]);
    vi.mocked(native.port!.stageOfferedContext).mockRejectedValueOnce(failure);
    await vi.advanceTimersByTimeAsync(1_000); expect(call.getSnapshot().state).toBe("ended");
  });
  it("never overlaps receives and waits at least one second after a complete batch", async () => {
    call = await CallSession.create({ ...options, fetch: fetcher() });
    const batch = gate<[]>(); vi.mocked(native.port!.receiveAgreement).mockImplementationOnce(() => batch.promise);
    await vi.advanceTimersByTimeAsync(1_000); expect(native.port!.receiveAgreement).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000); expect(native.port!.receiveAgreement).toHaveBeenCalledTimes(1);
    batch.resolve([]); await vi.advanceTimersByTimeAsync(999); expect(native.port!.receiveAgreement).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(native.port!.receiveAgreement).toHaveBeenCalledTimes(2);
  });
  it("waits for authoritative remote publication, then queries once before same-generation SAS receive", async () => {
    const remoteId = crypto.randomUUID(), remoteDevice = crypto.randomUUID(), remoteNonce = crypto.randomUUID();
    const published = (active: boolean): VoiceSnapshot => {
      const value = snapshot(); value.members[0].state = "waiting";
      value.members.push({ ...value.members[0], memberId: remoteId, userId: "remote", voiceDeviceId: remoteDevice, joinNonce: remoteNonce, voiceUserId: `@voice_${callId}_${remoteId}:opendiscord.local`, participantIdentity: `v1:${remoteId}`, state: active ? "active" : "waiting" });
      return value;
    };
    const issued: string[] = [];
    call = await CallSession.create({ ...options, fetch: async (_path, init) => {
      const body = JSON.parse(String(init?.body)); issued.push(body.action);
      if (body.action === "join") { nonce = body.input.joinNonce; deviceId = body.input.voiceDeviceId; return Response.json(published(false)); }
      return Response.json(body.action === "heartbeat" ? published(true) : { removals: [] });
    } });
    expect(call.getSnapshot().keysPrepared).toBe(false); expect(call.getSnapshot().roster[0].state).toBe("waiting");
    expect(native.port!.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999); expect(native.port!.query).not.toHaveBeenCalled(); expect(native.port!.receiveAgreement).not.toHaveBeenCalled();
    expect(issued).toEqual(["join"]);
    await vi.advanceTimersByTimeAsync(1); expect(native.port!.query).toHaveBeenCalledWith([memberId, remoteId]); expect(call.getSnapshot().keysPrepared).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000); expect(native.port!.receiveAgreement).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000); expect(native.port!.query).toHaveBeenCalledTimes(1);
    expect(call.getSnapshot().generation).toBe(1); expect(call.getSnapshot().admittedMemberIds).toEqual([]); expect(call.getSnapshot().sas).toEqual([]);
  });
  it("does not let a superseded preparation query mark the new authoritative generation ready", async () => {
    const query = gate<void>(); let conflict = true;
    vi.mocked(native.port!.query).mockImplementationOnce(() => query.promise);
    const opening = CallSession.create({ ...options, fetch: fetcher(action => {
      if (action === "heartbeat") return Response.json(snapshot(2));
      if (action === "crypto" && conflict) { conflict = false; return Response.json({ code: "conflict" }, { status: 409 }); }
      return Response.json({ cursor: "0", events: [], oneTimeKeys: { signed_curve25519: 0 }, unusedFallbackKeys: [] });
    }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(native.port!.query).toHaveBeenCalledTimes(1);
    await expect(dispatch(1)).rejects.toMatchObject({ code: "conflict" });
    expect(native.port!.transition).toHaveBeenCalledTimes(1);
    query.resolve(); call = await opening;
    expect(call.getSnapshot().generation).toBe(2); expect(call.getSnapshot().keysPrepared).toBe(false);
    expect(native.port!.receiveAgreement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native.port!.query).toHaveBeenCalledTimes(2); expect(call.getSnapshot().keysPrepared).toBe(true);
    expect(native.port!.receiveAgreement).toHaveBeenCalledTimes(1);
  });
  it("a delayed lease grant uses request start and resume checks cannot extend it", async () => {
    const join = gate<Response>();
    const pending = CallSession.create({ ...options, fetch: async (_path, init) => { const body = JSON.parse(String(init?.body)); nonce = body.input.joinNonce; deviceId = body.input.voiceDeviceId; return join.promise; } }).catch(error => error);
    await vi.advanceTimersByTimeAsync(4_000); join.resolve(Response.json(snapshot(1, 3_000)));
    expect(await pending).toMatchObject({ code: "lease-expired" }); expect(native.options).toBeUndefined();
  });
});
