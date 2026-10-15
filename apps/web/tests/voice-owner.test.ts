import { randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceCryptoOwner, type VoiceOwnerTransport } from "../src/lib/voice/crypto-owner";
import { acquireVoiceOwnerGuard, releaseUnusedVoiceOwnerGuard } from "../src/lib/voice/owner-guard";
import { validateVoiceOwnerControl, voiceControlParty, VOICE_CONTROL_EVENT } from "../src/lib/voice/owner-control";
import type { VoiceSnapshot } from "../src/lib/voice/contracts";

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
afterEach(() => { vi.unstubAllGlobals(); });
describe("unreachable serial voice owner", () => {
  it("requires an actually held one-use account lock and releases only after native cleanup", async () => {
    locks(); const current = snapshot(), accountId = current.members[0].userId, onFence = vi.fn();
    const guard = await acquireVoiceOwnerGuard(accountId);
    await expect(acquireVoiceOwnerGuard(accountId)).rejects.toThrow("already held");
    await expect(VoiceCryptoOwner.create({ accountId, guard: { accountId }, snapshot: current, lifetime: { assertCurrent() {} }, transport: unitTransport(), onFence })).rejects.toThrow("capability");
    const owner = await VoiceCryptoOwner.create({ accountId, guard, snapshot: current, lifetime: { assertCurrent() {} }, transport: unitTransport(), onFence });
    try {
      await expect(VoiceCryptoOwner.create({ accountId, guard, snapshot: current, lifetime: { assertCurrent() {} }, transport: unitTransport(), onFence })).rejects.toThrow("capability");
      expect(await owner.receive()).toEqual([]);
    } finally { const closed = owner.close(); expect(onFence).toHaveBeenCalledWith("closed"); await closed; }
    const next = await acquireVoiceOwnerGuard(accountId); releaseUnusedVoiceOwnerGuard(next);
  });
  it("keeps native DM keys unchanged, synchronously fences transition and refuses lifetime resurrection", async () => {
    locks(); await C.initAsync();
    const dm = await C.OlmMachine.initialize(new C.UserId(`@dm_owner_unit_${randomUUID()}:opendiscord.local`), new C.DeviceId(randomUUID()), undefined, undefined, { debug() {}, info() {}, warn() {}, error() {} });
    const before = dm.identityKeys.ed25519.toBase64();
    const current = snapshot(), accountId = current.members[0].userId, onFence = vi.fn(); let alive = true;
    const owner = await VoiceCryptoOwner.create({ accountId, guard: await acquireVoiceOwnerGuard(accountId), snapshot: current, lifetime: { assertCurrent() { if (!alive) throw new Error("Expired lifetime."); } }, transport: unitTransport(), onFence });
    try {
      const transition = owner.transition({ ...current, generation: 2 });
      expect(onFence).toHaveBeenCalledWith("generation-transition"); await transition;
      expect(await owner.receive()).toEqual([]);
      expect(dm.identityKeys.ed25519.toBase64()).toBe(before);
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
});
