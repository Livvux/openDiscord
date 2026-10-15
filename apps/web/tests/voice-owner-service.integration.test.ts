import { randomBytes, randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { channel, dmDevice, dmIdentity, dmKey, dmMailbox, dmMessage, dmSignature, session } from "@/db/schema";
import { voiceCallMember, voiceControlMailbox } from "@/db/voice-schema";
import { VoiceCryptoOwner, VoiceGenerationInterrupted, type VoiceOwnerTransport } from "@/lib/voice/crypto-owner";
import { acquireVoiceOwnerGuard, releaseUnusedVoiceOwnerGuard } from "@/lib/voice/owner-guard";
import { voiceControlParty, VOICE_CONTROL_EVENT, type VoiceOwnerControl } from "@/lib/voice/owner-control";
import type { VoiceSnapshot } from "@/lib/voice/contracts";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { registerDmDevice } from "@/server/direct-messages";
import { handleVoiceCrypto, heartbeatVoiceControl, joinVoiceControl, leaveVoiceControl } from "@/server/voice-control";
import { testUsers } from "./helpers";

// Internal real PostgreSQL service only. The sole fake is Node's absent browser Web Lock manager.
const users = testUsers();
const owners = new Set<VoiceCryptoOwner>();
type Dispatch = Parameters<VoiceOwnerTransport>[0];
type Endpoint = { userId: string; sessionId: string; anchorDeviceId: string; anchorSecret: string; secret: string; snapshot: VoiceSnapshot; owner: VoiceCryptoOwner; fence: ReturnType<typeof vi.fn>; lifetime: AbortController; calls: Dispatch[]; before?: (input: Dispatch) => Promise<void>; after?: (input: Dispatch, response: unknown) => Promise<void> };
const auth = (e: Endpoint) => ({ userId: e.userId, sessionId: e.sessionId, memberId: e.snapshot.memberId, secret: e.secret });
const binding = (e: Endpoint) => ({ callId: e.snapshot.callId, memberId: e.snapshot.memberId, joinNonce: e.snapshot.joinNonce, expectedGeneration: e.snapshot.generation });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
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
    endpoints.push({ ...account, secret, snapshot, calls: [], fence: vi.fn(), lifetime: new AbortController() } as Endpoint);
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
afterEach(async () => { for (const owner of owners) await owner.close(); owners.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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

  it.each(["session", "anchor", "lease"] as const)("fences actual %s authority denial without enqueue or lease renewal", async loss => {
    const [a, b] = await fixture();
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

  for (const phase of ["before-commit", "after-commit"] as const) it(`serializes late ${phase} send with real retirement and exactly one native completion`, async () => {
    const [a, b] = await fixture();
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
    await leaveVoiceControl(auth(b), binding(b));
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
