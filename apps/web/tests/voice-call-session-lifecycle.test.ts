import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession, VoiceRetirementConflict } from "@/lib/voice/call-session";
import type { VoiceOwnerOptions, VoiceProductOwnerPort } from "@/lib/voice/crypto-owner";
import { VoiceContextProposal } from "@/lib/voice/epoch-agreement";
import { VOICE_CONTROL_EVENT, voiceControlParty } from "@/lib/voice/owner-control";
import type { VoiceSnapshot } from "@/lib/voice/contracts";

const native = vi.hoisted(() => ({ options: undefined as VoiceOwnerOptions | undefined, port: undefined as VoiceProductOwnerPort | undefined }));
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
  native.options = undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const held = new Set<string>();
  vi.stubGlobal("navigator", { locks: { async request(name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) { if (held.has(name)) return callback(null); held.add(name); try { await callback({ name }); } finally { held.delete(name); } } } });
  vi.stubGlobal("window", { localStorage: { getItem: () => JSON.stringify({ id: crypto.randomUUID(), secret: "a".repeat(64), storeKey: "long-enough-development-store-key" }) } });
  native.port = { query: vi.fn(async () => {}), flush: vi.fn(async () => {}), requestVerification: vi.fn(async () => "flow"), verificationStep: vi.fn(async () => {}), verificationStates: vi.fn(async () => []), admit: vi.fn(async () => {}), transition: vi.fn(async () => {}), selectAudience: vi.fn(async () => {}), createContextOffer: vi.fn(), sendContextControl: vi.fn(async () => undefined), receiveAgreement: vi.fn(async () => []), stageOfferedContext: vi.fn(async () => {}), acceptContextControl: vi.fn(async () => false), retainPendingMaterial: vi.fn(async () => {}), installContext: vi.fn(async () => []), contextAgreementComplete: vi.fn(async () => false), sendControl: vi.fn(async () => {}), close: vi.fn(async () => {}) };
});
afterEach(async () => { await call?.close(); call = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
const options = { accountId: "account", sessionId: "session", channelId, consent: true as const, assertSessionCurrent() {} };
const dispatch = (generation: number) => native.options!.transport({ binding: { callId, memberId, joinNonce: nonce, expectedGeneration: generation }, request: { kind: "sync" }, signal: native.options!.lifetime.signal });
function fetcher(handle?: (action: string, generation: number) => Promise<Response> | Response): typeof fetch {
  return async (_path, init) => { const body = JSON.parse(String(init?.body)); if (body.action === "join") { nonce = body.input.joinNonce; deviceId = body.input.voiceDeviceId; return Response.json(snapshot()); } return handle?.(body.action, body.input.expectedGeneration) ?? Response.json(body.action === "heartbeat" ? snapshot() : body.action === "leave" ? { removals: [] } : { cursor: "0", events: [], oneTimeKeys: { signed_curve25519: 0 }, unusedFallbackKeys: [] }); };
}
describe("CallSession deterministic lifetime adapter (native port mocked, no native acceptance claim)", () => {
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
    let heartbeats = 0;
    call = await CallSession.create({ ...options, fetch: fetcher(action => {
      if (action === "heartbeat") { heartbeats++; return Response.json(snapshot(2)); }
      return Response.json({ code: "conflict" }, { status: 409 });
    }) });
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
    call = await CallSession.create({ ...options, fetch: fetcher(action => {
      if (action === "heartbeat") { heartbeats++; return Response.json(snapshot()); }
      return Response.json({ cursor: "0", events: [], oneTimeKeys: { signed_curve25519: 0 }, unusedFallbackKeys: [] });
    }) });
    for (let i = 0; i < 161; i++) await dispatch(1);
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
  it("never overlaps receives and waits at least one second after a complete batch", async () => {
    call = await CallSession.create({ ...options, fetch: fetcher() });
    const batch = gate<[]>(); vi.mocked(native.port!.receiveAgreement).mockImplementationOnce(() => batch.promise);
    await vi.advanceTimersByTimeAsync(1_000); expect(native.port!.receiveAgreement).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000); expect(native.port!.receiveAgreement).toHaveBeenCalledTimes(1);
    batch.resolve([]); await vi.advanceTimersByTimeAsync(999); expect(native.port!.receiveAgreement).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(native.port!.receiveAgreement).toHaveBeenCalledTimes(2);
  });
  it("a delayed lease grant uses request start and resume checks cannot extend it", async () => {
    const join = gate<Response>();
    const pending = CallSession.create({ ...options, fetch: async (_path, init) => { const body = JSON.parse(String(init?.body)); nonce = body.input.joinNonce; deviceId = body.input.voiceDeviceId; return join.promise; } }).catch(error => error);
    await vi.advanceTimersByTimeAsync(4_000); join.resolve(Response.json(snapshot(1, 3_000)));
    expect(await pending).toMatchObject({ code: "lease-expired" }); expect(native.options).toBeUndefined();
  });
});
