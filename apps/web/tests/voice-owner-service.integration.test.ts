import { randomBytes, randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { channel, dmDevice, dmIdentity, dmKey, dmMailbox, dmMessage, dmSignature, role, session } from "@/db/schema";
import { voiceCallMember, voiceControlMailbox, voicePrekey, voiceSignature } from "@/db/voice-schema";
import { VoiceCryptoOwner, VoiceGenerationInterrupted, type VoiceOwnerTransport } from "@/lib/voice/crypto-owner";
import { acquireVoiceOwnerGuard, releaseUnusedVoiceOwnerGuard } from "@/lib/voice/owner-guard";
import { voiceControlParty, VOICE_CONTROL_EVENT, type VoiceOwnerControl } from "@/lib/voice/owner-control";
import type { VoiceSnapshot } from "@/lib/voice/contracts";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { Permission } from "@/server/permissions";
import { registerDmDevice } from "@/server/direct-messages";
import { handleVoiceCrypto, heartbeatVoiceControl, joinVoiceControl, leaveVoiceControl } from "@/server/voice-control";
import { testUsers } from "./helpers";
import { PublicServicePeer } from "./fixtures/voice-service-peer";

// Internal real PostgreSQL service only. The sole fake is Node's absent browser Web Lock manager.
const users = testUsers();
const owners = new Set<VoiceCryptoOwner>();
const barriers = new Set<() => void>();
type Dispatch = Parameters<VoiceOwnerTransport>[0];
type Endpoint = { userId: string; sessionId: string; anchorDeviceId: string; anchorSecret: string; secret: string; snapshot: VoiceSnapshot; owner: VoiceCryptoOwner; fence: ReturnType<typeof vi.fn<(reason: string) => void>>; lifetime: AbortController; calls: Dispatch[]; before?: (input: Dispatch) => Promise<void>; after?: (input: Dispatch, response: unknown) => Promise<void> };
const auth = (e: Endpoint) => ({ userId: e.userId, sessionId: e.sessionId, memberId: e.snapshot.memberId, secret: e.secret });
const binding = (e: Endpoint) => ({ callId: e.snapshot.callId, memberId: e.snapshot.memberId, joinNonce: e.snapshot.joinNonce, expectedGeneration: e.snapshot.generation });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); barriers.add(resolve); return { promise, resolve }; }
function locks() {
  const held = new Set<string>();
  vi.stubGlobal("navigator", { locks: { async request(name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) { if (held.has(name)) return callback(null); held.add(name); try { await callback({ name }); } finally { held.delete(name); } } } });
}
async function fixture(count = 2, nativeOwners = count) {
  locks();
  const accounts = [];
  for (let i = 0; i < count; i++) {
    const userId = await users.create(`Owner service ${i}`), sessionId = randomUUID(), anchorDeviceId = randomUUID(), anchorSecret = randomBytes(32).toString("hex");
    await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
    await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Enrollment anchor only" });
    accounts.push({ userId, sessionId, anchorDeviceId, anchorSecret });
  }
  const community = await createCommunity(accounts[0].userId, "Owner actual service");
  const invite = await createInvite(accounts[0].userId, community.communityId, { expiresInHours: 24, maxUses: null });
  for (const account of accounts.slice(1)) await acceptInvite(account.userId, invite);
  const [ch] = await db.insert(channel).values({ communityId: community.communityId, name: "owner-service", kind: "voice" }).returning();
  const endpoints: Endpoint[] = [];
  for (const account of accounts) {
    const secret = randomBytes(32).toString("hex");
    const snapshot = await joinVoiceControl(account, { channelId: ch.id, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: secret, consent: true });
    let nativeOwner: VoiceCryptoOwner | undefined;
    endpoints.push({ ...account, secret, snapshot, calls: [], fence: vi.fn<(reason: string) => void>(), lifetime: new AbortController(),
      get owner() { if (!nativeOwner) throw new Error("Endpoint has no native owner yet."); return nativeOwner; },
      set owner(value: VoiceCryptoOwner) { nativeOwner = value; },
    });
  }
  for (const endpoint of endpoints) endpoint.snapshot = await heartbeatVoiceControl(auth(endpoint), binding(endpoint));
  for (const endpoint of endpoints.slice(0, nativeOwners)) {
    endpoint.owner = await VoiceCryptoOwner.create({ accountId: endpoint.userId, guard: await acquireVoiceOwnerGuard(endpoint.userId), snapshot: endpoint.snapshot, lifetime: { signal: endpoint.lifetime.signal, assertCurrent() {} }, onFence: endpoint.fence, transport: async input => {
      endpoint.calls.push({ binding: structuredClone(input.binding), request: structuredClone(input.request), signal: input.signal });
      await endpoint.before?.(input);
      const response = await handleVoiceCrypto(auth(endpoint), { ...input.binding, request: input.request });
      await endpoint.after?.(input, response);
      return response;
    } });
    owners.add(endpoint.owner);
  }
  return endpoints;
}
async function refresh(endpoints: Endpoint[]) {
  for (const e of endpoints) { e.snapshot = await heartbeatVoiceControl(auth(e), binding(e)); await e.owner.transition(e.snapshot); }
}
async function state(e: Endpoint, peer?: Endpoint) { const value = (await e.owner.verificationStates()).find(s => !peer || s.peer.memberId === peer.snapshot.memberId); if (!value) throw new Error("Missing real owner SAS state."); return value; }
async function verify(a: Endpoint, b: Endpoint) {
  const decimals = new Map<string, number[]>();
  const emojiIndex = C.Sas.prototype.emojiIndex;
  const observation = vi.spyOn(C.Sas.prototype, "emojiIndex").mockImplementation(function(this: C.Sas) {
    const decimal = this.decimals();
    if (decimal) decimals.set(this.userId.toString(), Array.from(decimal));
    return emojiIndex.call(this);
  });
  const handle = await a.owner.requestVerification(b.snapshot.memberId);
  await b.owner.receive(); const remote = await state(b, a);
  await b.owner.verificationStep(remote.handle, "accept"); await a.owner.receive();
  await a.owner.verificationStep(handle, "start"); await b.owner.receive();
  await b.owner.verificationStep(remote.handle, "accept-sas"); await a.owner.receive(); await b.owner.receive(); await a.owner.receive();
  // Compare both actual public owner SAS values before the test acts as the human confirmer.
  const first = await state(a, b), second = await state(b, a);
  expect(first.emojiIndices).toHaveLength(7); expect(first.emojiIndices).toEqual(second.emojiIndices);
  expect(first.confirmed).toBe(false); expect(second.confirmed).toBe(false);
  expect(decimals.size).toBe(2);
  expect([...decimals.values()][0]).toHaveLength(3);
  expect([...decimals.values()][0]).toEqual([...decimals.values()][1]);
  observation.mockRestore();
  await a.owner.verificationStep(handle, "confirm"); await b.owner.verificationStep(remote.handle, "confirm");
  for (let round = 0; round < 3; round++) { await a.owner.receive(); await b.owner.receive(); }
  await a.owner.query([a.snapshot.memberId, b.snapshot.memberId]); await b.owner.query([a.snapshot.memberId, b.snapshot.memberId]);
  expect((await state(a, b)).done).toBe(true); expect((await state(b, a)).done).toBe(true);
  await a.owner.admit(b.snapshot.memberId); await b.owner.admit(a.snapshot.memberId);
}
async function verifyPublicPeer(a: Endpoint, b: Endpoint, peer: PublicServicePeer) {
  const decimals = new Map<string, number[]>(), original = C.Sas.prototype.emojiIndex;
  const observation = vi.spyOn(C.Sas.prototype, "emojiIndex").mockImplementation(function(this: C.Sas) {
    const values = this.decimals(); if (values) decimals.set(this.userId.toString(), Array.from(values));
    return original.call(this);
  });
  await peer.query();
  const handle = await a.owner.requestVerification(b.snapshot.memberId); await peer.receive();
  const ownMember = a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!;
  const request = peer.verification(ownMember), ready = request.acceptWithMethods([C.VerificationMethod.SasV1]);
  if (!ready) throw new Error("Missing genuine peer SAS ready.");
  await peer.out(ready); await a.owner.receive();
  await a.owner.verificationStep(handle, "start"); await peer.receive();
  const sas = peer.sas(ownMember), accept = sas.accept(); if (accept) await peer.out(accept);
  await a.owner.receive(); await peer.receive(); await a.owner.receive();
  const nativeState = await state(a, b);
  expect(nativeState.emojiIndices).toHaveLength(7); expect(nativeState.emojiIndices).toEqual(Array.from(sas.emojiIndex()!));
  expect(decimals.size).toBe(2); expect([...decimals.values()][0]).toHaveLength(3);
  expect([...decimals.values()][0]).toEqual([...decimals.values()][1]); observation.mockRestore();
  await a.owner.verificationStep(handle, "confirm");
  for (const output of await sas.confirm()) await peer.out(output);
  for (let round = 0; round < 3; round++) { await a.owner.receive(); await peer.receive(); }
  await a.owner.query([a.snapshot.memberId, b.snapshot.memberId]); await peer.query();
  expect((await state(a, b)).done).toBe(true); expect(sas.isDone()).toBe(true);
  await a.owner.admit(b.snapshot.memberId);
}
async function context(a: Endpoint, b: Endpoint) {
  const epochId = randomUUID(), ids = [a.snapshot.memberId, b.snapshot.memberId];
  await a.owner.setControlContext(epochId, ids); await b.owner.setControlContext(epochId, ids);
  return epochId;
}
function material(a: Endpoint, b: Endpoint, epochId: string): VoiceOwnerControl {
  const sender = voiceControlParty(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!);
  const recipient = voiceControlParty(b.snapshot.members.find(m => m.memberId === b.snapshot.memberId)!);
  return { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: a.snapshot.callId, generation: a.snapshot.generation, epochId, sender, recipient, publisher: sender, audience: [sender, recipient].sort((x, y) => x.memberId.localeCompare(y.memberId)), keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, 9).toString("base64") };
}
async function dmBaseline() { return Promise.all([db.select().from(dmIdentity), db.select().from(dmKey), db.select().from(dmMailbox), db.select().from(dmMessage), db.select().from(dmSignature)]); }
afterEach(async () => { for (const release of barriers) release(); barriers.clear(); for (const owner of owners) await owner.close(); owners.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => users.cleanup());

describe("unreachable VoiceCryptoOwner against the actual PostgreSQL voice service", () => {
  it("completes two-owner genuine SAS, explicit admissions and bidirectional typed Olm controls without DM writes", async () => {
    const [a, b] = await fixture(); const baseline = await dmBaseline();
    await verify(a, b); const epoch = await context(a, b);
    const forward = material(a, b, epoch); await a.owner.sendControl(forward); expect(await b.owner.receive()).toEqual([forward]);
    const reverse = material(b, a, epoch); await b.owner.sendControl(reverse); expect(await a.owner.receive()).toEqual([reverse]);
    expect(await dmBaseline()).toEqual(baseline);
    expect(a.calls.some(c => c.request.kind === "claim")).toBe(true);
  }, 30_000);

  for (const change of ["generation", "epochId", "audience"] as const) it(`rejects separately ${change}-only stale payload after genuine verified Olm decryption`, async () => {
    const [a, b] = await fixture(2, 1);
    const peer = await PublicServicePeer.create(b.snapshot, input => handleVoiceCrypto(auth(b), { ...input.binding, request: input.request }));
    try {
      await verifyPublicPeer(a, b, peer);
      const epoch = randomUUID(); await a.owner.setControlContext(epoch, [a.snapshot.memberId, b.snapshot.memberId]);
      const positive = material(b, a, epoch);
      await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, positive);
      expect(await a.owner.receive()).toEqual([positive]);
      const invalid = { ...positive, transaction: randomUUID(), [change]: change === "generation" ? positive.generation + 1 : change === "epochId" ? randomUUID() : [positive.sender] };
      await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, invalid);
      const sends = a.calls.filter(c => c.request.kind === "send").length;
      await expect(a.owner.receive()).rejects.toThrow(change === "audience" ? "audience mismatch" : "Stale voice control binding");
      expect(a.calls.filter(c => c.request.kind === "send")).toHaveLength(sends);
      expect(a.fence).toHaveBeenCalledWith("native-or-schema-failure");
      await expect(a.owner.admit(b.snapshot.memberId)).rejects.toThrow("closed");
    } finally { peer.close(); }
  }, 30_000);

  for (const change of ["generation", "epoch", "audience"] as const) it(`fences a genuinely decrypted control across an ack-delivery ${change} change`, async () => {
    const endpoints = await fixture(3), [a, b, c] = endpoints;
    await verify(a, b);
    if (change === "audience") { await verify(a, c); await verify(b, c); }
    const epoch = await context(a, b);
    const positive = material(a, b, epoch); await a.owner.sendControl(positive);
    expect(await b.owner.receive()).toEqual([positive]);
    const entered = deferred(), release = deferred();
    b.after = async input => { if (input.request.kind === "ack") { entered.resolve(); await release.promise; } };
    const control = material(a, b, epoch); await a.owner.sendControl(control);
    const receive = b.owner.receive();
    const outcome = receive.then(value => ({ value }), error => ({ error: error as unknown }));
    await entered.promise;
    if (change === "generation") {
      await leaveVoiceControl(auth(c), binding(c));
      b.snapshot = await heartbeatVoiceControl(auth(b), binding(b));
      await b.owner.transition(b.snapshot);
    } else await b.owner.setControlContext(change === "epoch" ? randomUUID() : epoch, change === "audience" ? endpoints.map(e => e.snapshot.memberId) : [a.snapshot.memberId, b.snapshot.memberId]);
    release.resolve();
    expect(await outcome).toMatchObject({ error: expect.any(VoiceGenerationInterrupted) });
    b.after = undefined;
    // A revision fence keeps the owner alive and cannot itself grant new admission.
    expect(await b.owner.receive()).toEqual([]);
  }, 30_000);

  it("returns truthful signature refusal for genuine pending SAS output without remote storage or losing the current peer", async () => {
    const [a, b, c] = await fixture(3); await verify(a, c);
    const entered = deferred(), release = deferred(); let paused = false;
    const responses: { input: Dispatch; response: unknown }[] = [];
    a.before = async input => {
      if (input.request.kind === "signatures" && Object.hasOwn(input.request.body, b.snapshot.voiceUserId) && !paused) { paused = true; entered.resolve(); await release.promise; }
    };
    a.after = async (input, response) => { if (input.request.kind === "signatures") responses.push({ input, response }); };
    const verification = verify(a, b), outcome = verification.then(() => undefined, error => error as unknown);
    await entered.promise;
    const before = await db.select().from(voiceSignature);
    await leaveVoiceControl(auth(b), binding(b)); a.snapshot = await heartbeatVoiceControl(auth(a), binding(a));
    await a.owner.transition(a.snapshot);
    const fresh = responses.find(item => item.input.binding.expectedGeneration === a.snapshot.generation);
    if (!fresh || fresh.input.request.kind !== "signatures") throw new Error("Missing actual pending signature re-dispatch.");
    const expected: Record<string, { errcode: string; error: string }> = {};
    for (const key of Object.keys(fresh.input.request.body[b.snapshot.voiceUserId] as Record<string, unknown>)) expected[key] = { errcode: "M_FORBIDDEN", error: "Current voice signature target is unavailable." };
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    expect(fresh.response).toEqual({ failures: { [b.snapshot.voiceUserId]: expected } });
    expect(await db.select().from(voiceSignature)).toEqual(before.filter(row => row.targetMemberId !== b.snapshot.memberId));
    release.resolve(); expect(await outcome).toBeInstanceOf(VoiceGenerationInterrupted);
    await refresh([c]); const epoch = await context(a, c), control = material(a, c, epoch);
    await a.owner.sendControl(control); expect(await c.owner.receive()).toEqual([control]);
  }, 30_000);

  it("re-dispatches a genuine pending native claim into actual current-generation absence during transition", async () => {
    const [a, b, c] = await fixture(3); await verify(a, b); await verify(a, c); const epoch = await context(a, b);
    const entered = deferred(), release = deferred(); let paused = false;
    const responses: { input: Dispatch; response: unknown }[] = [];
    a.before = async input => {
      if (input.request.kind === "claim" && !paused) { paused = true; entered.resolve(); await release.promise; }
    };
    a.after = async (input, response) => { if (input.request.kind === "claim") responses.push({ input, response }); };
    const send = a.owner.sendControl(material(a, b, epoch));
    const outcome = send.then(() => undefined, error => error as unknown);
    await entered.promise;
    const old = a.calls.find(c => c.request.kind === "claim")!;
    await leaveVoiceControl(auth(b), binding(b));
    a.snapshot = await heartbeatVoiceControl(auth(a), binding(a));
    await a.owner.transition(a.snapshot);
    const fresh = responses.find(item => item.input.binding.expectedGeneration === a.snapshot.generation);
    expect(fresh?.response).toEqual({ one_time_keys: {}, failures: {} });
    if (!fresh || old.request.kind !== "claim" || fresh.input.request.kind !== "claim") throw new Error("Missing genuine native claim re-dispatch.");
    expect(fresh.input.request.nativeRequestId).toBe(old.request.nativeRequestId);
    expect(fresh.input.request.body).toEqual(old.request.body);
    expect(fresh.input.request.requestId).not.toBe(old.request.requestId);
    const prekeys = await db.select().from(voicePrekey);
    expect(await handleVoiceCrypto(auth(a), { ...fresh.input.binding, request: fresh.input.request })).toEqual(fresh.response);
    expect(await db.select().from(voicePrekey)).toEqual(prekeys);
    release.resolve(); expect(await outcome).toBeInstanceOf(VoiceGenerationInterrupted);
    expect(a.fence).not.toHaveBeenCalledWith("transport-or-completion-failure");
    await refresh([c]);
    const currentEpoch = await context(a, c), forward = material(a, c, currentEpoch);
    await a.owner.sendControl(forward); expect(await c.owner.receive()).toEqual([forward]);
    const reverse = material(c, a, currentEpoch);
    await c.owner.sendControl(reverse); expect(await a.owner.receive()).toEqual([reverse]);
  }, 30_000);

  it("processes genuine native query device absence without invented keys or a busy loop", async () => {
    const [a, unbootstrapped] = await fixture(2, 1);
    const responses: unknown[] = [];
    a.after = async (input, response) => { if (input.request.kind === "query") responses.push(response); };
    await a.owner.query([unbootstrapped.snapshot.memberId]);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ device_keys: { [unbootstrapped.snapshot.voiceUserId]: {} }, failures: {} });
    const before = a.calls.length;
    await a.owner.flush();
    expect(a.calls.length - before).toBeLessThanOrEqual(4);
    await expect(a.owner.requestVerification(unbootstrapped.snapshot.memberId)).rejects.toThrow("Missing current native voice device");
    expect(a.fence).toHaveBeenCalledWith("native-or-schema-failure");
    expect(await db.$count(voiceControlMailbox, eq(voiceControlMailbox.callId, a.snapshot.callId))).toBe(0);
  });

  it.each(["session", "anchor", "lease", "permission"] as const)("fences actual %s authority denial without enqueue or lease renewal", async loss => {
    const [first, second] = await fixture();
    const a = loss === "permission" ? second : first, b = loss === "permission" ? first : second;
    if (loss === "permission") {
      const [ch] = await db.select().from(channel).where(eq(channel.id, a.snapshot.channelId));
      await db.update(role).set({ permissions: sql`${role.permissions} & ${~Permission.Connect}` }).where(and(eq(role.communityId, ch.communityId), eq(role.isDefault, true)));
    }
    if (loss === "session") await db.update(session).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(session.id, a.sessionId));
    if (loss === "anchor") await db.update(dmDevice).set({ revokedAt: new Date() }).where(eq(dmDevice.id, a.anchorDeviceId));
    if (loss === "lease") await db.update(voiceCallMember).set({ leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(voiceCallMember.id, a.snapshot.memberId));
    const [before] = await db.select().from(voiceCallMember).where(eq(voiceCallMember.id, a.snapshot.memberId));
    const count = await db.$count(voiceControlMailbox);
    await expect(a.owner.requestVerification(b.snapshot.memberId)).rejects.toMatchObject({ code: "forbidden" });
    expect(a.fence).toHaveBeenCalled(); await expect(a.owner.flush()).rejects.toThrow("closed");
    const [after] = await db.select().from(voiceCallMember).where(eq(voiceCallMember.id, a.snapshot.memberId));
    expect(after.leaseExpiresAt.getTime()).toBeLessThanOrEqual(before.leaseExpiresAt.getTime());
    expect(await db.$count(voiceControlMailbox)).toBe(count);
  });

  for (const targetState of ["removed", "current"] as const) for (const phase of ["before-commit", "after-commit"] as const) it(`serializes late ${phase} send to ${targetState} target with real retirement and exactly one native completion`, async () => {
    const [a, b, c] = await fixture(3);
    const entered = deferred(), release = deferred(), completing = deferred(), finish = deferred();
    let target: string | undefined;
    const completions: string[] = [];
    const original = C.OlmMachine.prototype.markRequestAsSent;
    vi.spyOn(C.OlmMachine.prototype, "markRequestAsSent").mockImplementation(async function(this: C.OlmMachine, id, type, response) {
      if (id === target) { completions.push(id); completing.resolve(); await finish.promise; }
      return original.call(this, id, type, response);
    });
    const pause = async (input: Dispatch) => {
      if (input.request.kind === "send" && input.request.eventType === "m.key.verification.request") {
        target = input.request.nativeRequestId; entered.resolve(); await release.promise;
      }
    };
    if (phase === "before-commit") a.before = pause; else a.after = pause;
    const request = a.owner.requestVerification(b.snapshot.memberId);
    // Attach rejection handler before opening the competing transition.
    const outcome = request.then(value => ({ value }), error => ({ error: error as unknown }));
    await entered.promise;
    const originalSend = a.calls.find(c => c.request.kind === "send")!;
    const departing = targetState === "removed" ? b : c;
    await leaveVoiceControl(auth(departing), binding(departing));
    a.snapshot = await heartbeatVoiceControl(auth(a), binding(a));
    const transition = a.owner.transition(a.snapshot);
    await completing.promise;
    // Retirement is in the native completion await when old HTTP work resumes.
    release.resolve(); finish.resolve(); await transition;
    const result = await outcome;
    if (phase === "after-commit") expect(result).toMatchObject({ error: expect.any(VoiceGenerationInterrupted) });
    else expect(result).toMatchObject({ error: { code: "conflict" } });
    expect(completions).toEqual([target]);
    const retired = a.calls.find(c => c.request.kind === "retire" && c.request.nativeRequestId === target)!;
    expect(retired).toBeDefined();
    if (originalSend.request.kind !== "send" || retired.request.kind !== "retire") throw new Error("Missing genuine transport attempts.");
    expect(retired.request.body).toEqual(originalSend.request.body);
    expect(retired.request.nativeTxnId).toBe(originalSend.request.nativeTxnId);
    expect(retired.request.requestId).not.toBe(originalSend.request.requestId);
    expect(retired.binding.expectedGeneration).toBe(a.snapshot.generation);
    expect(await db.$count(voiceControlMailbox, eq(voiceControlMailbox.callId, a.snapshot.callId))).toBe(0);
  }, 30_000);

  it("completes genuine historical send before delayed real retirement response exactly once", async () => {
    const [a, b, c] = await fixture(3);
    const sent = deferred(), releaseSend = deferred(), retired = deferred(), releaseRetire = deferred(), completed = deferred();
    let id: string | undefined;
    const completions: string[] = [], original = C.OlmMachine.prototype.markRequestAsSent;
    a.after = async input => {
      if (input.request.kind === "send" && input.request.eventType === "m.key.verification.request") { id = input.request.nativeRequestId; sent.resolve(); await releaseSend.promise; }
      if (input.request.kind === "retire" && input.request.nativeRequestId === id) { retired.resolve(); await releaseRetire.promise; }
    };
    vi.spyOn(C.OlmMachine.prototype, "markRequestAsSent").mockImplementation(async function(this: C.OlmMachine, nativeId, type, response) {
      if (nativeId === id) completions.push(nativeId);
      const result = await original.call(this, nativeId, type, response);
      if (nativeId === id) completed.resolve();
      return result;
    });
    const requested = a.owner.requestVerification(b.snapshot.memberId);
    const outcome = requested.then(value => ({ value }), error => ({ error: error as unknown }));
    await sent.promise;
    expect(await db.$count(voiceControlMailbox, eq(voiceControlMailbox.senderMemberId, a.snapshot.memberId))).toBe(1);
    await leaveVoiceControl(auth(c), binding(c));
    a.snapshot = await heartbeatVoiceControl(auth(a), binding(a));
    const transition = a.owner.transition(a.snapshot); await retired.promise;
    releaseSend.resolve(); await completed.promise;
    expect(completions).toEqual([id]);
    releaseRetire.resolve(); await transition;
    expect(await outcome).toMatchObject({ error: expect.any(VoiceGenerationInterrupted) });
    expect(completions).toEqual([id]);
    a.after = undefined;
    expect(await a.owner.requestVerification(b.snapshot.memberId)).toBeTruthy();
    expect(a.calls.at(-1)?.request.kind).toBe("send");
  }, 30_000);

  it("retires an unknown committed encrypted send and ignores its stale response timeout while retaining current peers", async () => {
    const [a, b, c] = await fixture(3); await verify(a, b); const epoch = await context(a, b);
    const committed = deferred(), timeout = deferred(); let id: string | undefined;
    a.after = async input => {
      if (input.request.kind === "send" && input.request.eventType === "m.room.encrypted" && !id) {
        id = input.request.nativeRequestId; committed.resolve(); await timeout.promise;
        throw new Error("Test network response timeout after unknown commit.");
      }
    };
    const sent = a.owner.sendControl(material(a, b, epoch)), outcome = sent.then(() => undefined, error => error as unknown);
    await committed.promise;
    const original = a.calls.find(item => item.request.kind === "send" && item.request.nativeRequestId === id)!;
    const queued = await db.$count(voiceControlMailbox);
    expect(await handleVoiceCrypto(auth(a), { ...original.binding, request: original.request })).toEqual({ nativeResponse: {}, disposition: { status: "processed-current", enqueued: 1 } });
    expect(await db.$count(voiceControlMailbox)).toBe(queued);
    await leaveVoiceControl(auth(c), binding(c));
    a.snapshot = await heartbeatVoiceControl(auth(a), binding(a)); await a.owner.transition(a.snapshot);
    const retired = a.calls.find(item => item.request.kind === "retire" && item.request.nativeRequestId === id);
    expect(retired).toBeDefined();
    timeout.resolve(); expect(await outcome).toBeInstanceOf(VoiceGenerationInterrupted);
    a.after = undefined; await refresh([b]);
    const freshEpoch = await context(a, b), forward = material(a, b, freshEpoch);
    await a.owner.sendControl(forward); expect(await b.owner.receive()).toEqual([forward]);
    const reverse = material(b, a, freshEpoch); await b.owner.sendControl(reverse); expect(await a.owner.receive()).toEqual([reverse]);
  }, 30_000);

  it("holds the account guard until native cleanup completes after lifetime abort", async () => {
    const [a, b] = await fixture();
    const entered = deferred(), release = deferred();
    const original = C.OlmMachine.prototype.markRequestAsSent;
    let pause = true;
    vi.spyOn(C.OlmMachine.prototype, "markRequestAsSent").mockImplementation(async function(this: C.OlmMachine, ...args) {
      if (pause && this.userId.toString() === a.snapshot.voiceUserId) { pause = false; entered.resolve(); await release.promise; }
      return original.apply(this, args);
    });
    const query = a.owner.query([b.snapshot.memberId]);
    const outcome = query.then(() => undefined, error => error as unknown);
    await entered.promise; a.lifetime.abort(); const closed = a.owner.close();
    expect(a.fence).toHaveBeenCalledWith("lifetime-lost");
    await expect(acquireVoiceOwnerGuard(a.userId)).rejects.toThrow("already held");
    release.resolve(); await closed; await outcome;
    const next = await acquireVoiceOwnerGuard(a.userId); await releaseUnusedVoiceOwnerGuard(next);
    await expect(a.owner.admit(b.snapshot.memberId)).rejects.toThrow("closed");
  });

  it("retains previously admitted exact bindings through a real membership removal and fresh epoch", async () => {
    const [a, b, removed] = await fixture(3);
    await verify(a, b);
    await leaveVoiceControl(auth(removed), binding(removed));
    await refresh([a, b]);
    const epoch = await context(a, b), value = material(a, b, epoch);
    await a.owner.sendControl(value); expect(await b.owner.receive()).toEqual([value]);
    expect(a.snapshot.members.map(m => m.memberId)).not.toContain(removed.snapshot.memberId);
    expect(a.snapshot.voiceUserId).toBe(b.snapshot.members.find(m => m.memberId === a.snapshot.memberId)?.voiceUserId);
  }, 30_000);
});
