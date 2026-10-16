import { randomBytes, randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { expect, vi } from "vitest";
import { db } from "@/db";
import { channel, session } from "@/db/schema";
import { VoiceCryptoOwner, type VoiceOwnerTransport } from "@/lib/voice/crypto-owner";
import { acquireVoiceOwnerGuard } from "@/lib/voice/owner-guard";
import type { VoiceSnapshot } from "@/lib/voice/contracts";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { registerDmDevice } from "@/server/direct-messages";
import { handleVoiceCrypto, heartbeatVoiceControl, joinVoiceControl } from "@/server/voice-control";
import { testUsers } from "../helpers";

const users = testUsers();
const owners = new Set<VoiceCryptoOwner>();
type Dispatch = Parameters<VoiceOwnerTransport>[0];
export type AgreementEndpoint = { userId: string; sessionId: string; anchorDeviceId: string; anchorSecret: string; secret: string; snapshot: VoiceSnapshot; owner: VoiceCryptoOwner; fence: ReturnType<typeof vi.fn<(reason: string) => void>>; lifetime: AbortController; calls: Dispatch[]; before?: (input: Dispatch) => Promise<void>; after?: (input: Dispatch, response: unknown) => Promise<void> };
const auth = (e: AgreementEndpoint) => ({ userId: e.userId, sessionId: e.sessionId, memberId: e.snapshot.memberId, secret: e.secret });
const binding = (e: AgreementEndpoint) => ({ callId: e.snapshot.callId, memberId: e.snapshot.memberId, joinNonce: e.snapshot.joinNonce, expectedGeneration: e.snapshot.generation });
function locks() {
  const held = new Set<string>();
  vi.stubGlobal("navigator", { locks: { async request(name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) { if (held.has(name)) return callback(null); held.add(name); try { await callback({ name }); } finally { held.delete(name); } } } });
}
export async function agreementServiceFixture(count = 2, nativeOwners = count, beforeNative?: () => Promise<void>) {
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
  const endpoints: AgreementEndpoint[] = [];
  for (const account of accounts) {
    const secret = randomBytes(32).toString("hex");
    const snapshot = await joinVoiceControl(account, { channelId: ch.id, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: secret, consent: true });
    let nativeOwner: VoiceCryptoOwner | undefined;
    endpoints.push({ ...account, secret, snapshot, calls: [], fence: vi.fn<(reason: string) => void>(), lifetime: new AbortController(),
      get owner() { if (!nativeOwner) throw new Error("AgreementEndpoint has no native owner yet."); return nativeOwner; },
      set owner(value: VoiceCryptoOwner) { nativeOwner = value; },
    });
  }
  for (const endpoint of endpoints) endpoint.snapshot = await heartbeatVoiceControl(auth(endpoint), binding(endpoint));
  await beforeNative?.();
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
async function state(e: AgreementEndpoint, peer?: AgreementEndpoint) { const value = (await e.owner.verificationStates()).find(s => !peer || s.peer.memberId === peer.snapshot.memberId); if (!value) throw new Error("Missing real owner SAS state."); return value; }
export async function verifyAgreementPeers(a: AgreementEndpoint, b: AgreementEndpoint) {
  await b.owner.query([a.snapshot.memberId, b.snapshot.memberId]);
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
export async function closeAgreementFixture() { for (const owner of owners) await owner.close(); owners.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
export async function cleanupAgreementUsers() { await users.cleanup(); }
