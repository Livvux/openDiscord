import { randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { expect, vi } from "vitest";
import type { VoiceSnapshot } from "../../src/lib/voice/contracts";
import { VoiceCryptoOwner, type VoiceOwnerTransport } from "../../src/lib/voice/crypto-owner";
import { acquireVoiceOwnerGuard } from "../../src/lib/voice/owner-guard";
import { OwnerUnitPeer, OwnerUnitWire } from "./voice-owner-peer";

/** Payload feasibility only: eight exact parties, two actual native endpoints, no media. */
export async function contextWireFixture(onRequest: VoiceOwnerTransport, idKind: "uuid" | "max-ascii" | "max-utf8", senderLeader: boolean, count = 8) {
  const held = new Set<string>();
  vi.stubGlobal("navigator", { locks: { async request(name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) { if (held.has(name)) return callback(null); held.add(name); try { await callback({ name }); } finally { held.delete(name); } } } });
  const callId = randomUUID();
  const members = Array.from({ length: count }, (_, index) => {
    const memberId = randomUUID();
    return { memberId, userId: idKind === "uuid" ? randomUUID() : `${index}`.padEnd(128, idKind === "max-ascii" ? "u" : "界"), voiceDeviceId: randomUUID(), joinNonce: randomUUID(), voiceUserId: `@voice_${callId}_${memberId}:opendiscord.local`, participantIdentity: `v1:${memberId}`, anchorDeviceId: randomUUID(), displayName: "Wire feasibility", state: "waiting" as const };
  }).sort((a, b) => a.memberId.localeCompare(b.memberId));
  const own = members[senderLeader ? 1 : 0], remote = members[senderLeader ? 0 : 1];
  const snapshot: VoiceSnapshot = { callId, channelId: randomUUID(), generation: 1, ...own, members, removals: [], serverTime: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() };
  const wire = new OwnerUnitWire(snapshot);
  const port = wire.port(remote.memberId);
  const peer = await OwnerUnitPeer.create({ ...snapshot, ...remote }, async input => { await onRequest(input); return port(input); });
  let owner: VoiceCryptoOwner | undefined;
  try {
    owner = await VoiceCryptoOwner.create({ accountId: own.userId, guard: await acquireVoiceOwnerGuard(own.userId), snapshot, lifetime: { signal: new AbortController().signal, assertCurrent() {} }, transport: wire.port(own.memberId), onFence() {} });
    await peer.query();
    const handle = await owner.requestVerification(remote.memberId); await peer.receive();
    const state = (await owner.verificationStates()).find(state => state.handle === handle)!;
    const request = peer.machine.getVerificationRequest(new C.UserId(own.voiceUserId), state.flowId);
    if (!request) throw new Error("Missing genuine wire SAS request.");
    const ready = request.acceptWithMethods([C.VerificationMethod.SasV1]); if (!ready) throw new Error("Missing native ready.");
    await peer.out(ready); await owner.receive();
    await owner.verificationStep(handle, "start"); await peer.receive();
    const sas = request.getVerification(); if (!(sas instanceof C.Sas)) throw new Error("Missing native SAS.");
    const accept = sas.accept(); if (accept) await peer.out(accept);
    await owner.receive(); await peer.receive(); await owner.receive();
    expect((await owner.verificationStates())[0].emojiIndices).toEqual(Array.from(sas.emojiIndex()!));
    await owner.verificationStep(handle, "confirm");
    for (const output of await sas.confirm()) await peer.out(output);
    await owner.receive(); await peer.receive(); await owner.receive(); await peer.receive();
    await owner.query(members.map(member => member.memberId)); await peer.query();
    expect((await owner.verificationStates())[0].done).toBe(true);
    return { snapshot, own, remote, peer, owner, close: async () => { await owner!.close(); peer.close(); } };
  } catch (error) { await owner?.close(); peer.close(); throw error; }
}
