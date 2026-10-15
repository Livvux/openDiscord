import { createHash, randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { describe, expect, it } from "vitest";
import { EphemeralVoice, VoiceTransport, verifyPair } from "./fixtures/ephemeral-voice";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
function fingerprint(machine: C.OlmMachine) {
  return { curve: machine.identityKeys.curve25519.toBase64(), ed: machine.identityKeys.ed25519.toBase64() };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
async function snapshot(machine: C.OlmMachine) {
  const counts = await machine.roomKeyCounts();
  return {
    keys: fingerprint(machine), total: counts.total, backedUp: counts.backedUp,
    verified: (await machine.getIdentity(machine.userId))?.isVerified() ?? false,
    verificationFlows: machine.getVerificationRequests(machine.userId).map((request) => request.flowId),
    outgoing: (await machine.outgoingRequests()).map((request) => ({
      type: request.type,
      // Native 18.9.0 reissues upload/query IDs even on consecutive reads without any voice operation.
      id: request.type === C.RequestType.KeysUpload || request.type === C.RequestType.KeysQuery ? null : request.id,
      digest: createHash("sha256").update(JSON.stringify(canonical(JSON.parse(request.body)))).digest("hex"),
    })).sort((a, b) => a.type - b.type || a.digest.localeCompare(b.digest) || (a.id ?? "").localeCompare(b.id ?? "")),
  };
}

describe("disposable voice OlmMachine supported API proof", () => {
  it("uses fresh native SAS/admission for three devices without changing the independent DM baseline", async () => {
    await C.initAsync();
    const dm = await C.OlmMachine.initialize(new C.UserId(`@dm_fixture_${randomUUID()}:opendiscord.invalid`), new C.DeviceId(randomUUID()), undefined, undefined, logger);
    const transport = new VoiceTransport();
    const opened: EphemeralVoice[] = [];
    try {
      // Ordinary valid local history on an independent baseline; no user's store or keys are imported.
      const room = new C.RoomId(`!dm_fixture_${randomUUID()}:opendiscord.invalid`);
      await dm.shareRoomKey(room, [], new C.EncryptionSettings());
      const history = { msgtype: "m.text", body: "Independent DM fixture history", transaction: randomUUID() };
      const event = { type: "m.room.encrypted", event_id: `$${randomUUID()}`, sender: dm.userId.toString(), origin_server_ts: Date.now(), content: JSON.parse(await dm.encryptRoomEvent(room, "m.room.message", JSON.stringify(history))) };
      const decryptHistory = async () => JSON.parse((await dm.decryptRoomEvent(JSON.stringify(event), room, new C.DecryptionSettings(C.TrustRequirement.Untrusted))).event).content;
      expect(await decryptHistory()).toEqual(history);
      const baseline = await snapshot(dm);
      expect(await snapshot(dm)).toEqual(baseline); // No voice activity between these control snapshots.
      for (let i = 0; i < 3; i++) opened.push(await EphemeralVoice.open(transport));
      const [a, b, c] = opened;
      for (const owner of opened) {
        expect(owner.machine.roomKeyRequestsEnabled).toBe(false);
        expect(owner.machine.roomKeyForwardingEnabled).toBe(false);
        expect(fingerprint(owner.machine)).not.toEqual(baseline.keys);
        expect((await owner.machine.roomKeyCounts()).total).toBe(0);
      }
      expect(new Set(opened.map((owner) => fingerprint(owner.machine).curve)).size).toBe(3);
      await a.query([a, b, c]); await b.query([a, b, c]); await c.query([a, b, c]);
      expect((await a.device(b)).isVerified()).toBe(false);
      expect((await a.device(c)).isVerified()).toBe(false);
      const beforeRefusal = transport.submitted.length;
      await expect(a.admit(c)).rejects.toThrow("Fresh voice SAS required.");
      await expect(a.send(c, "Unadmitted fixture control")).rejects.toThrow("explicitly admitted");
      expect(transport.submitted).toHaveLength(beforeRefusal);
      expect(transport.queued(c)).toBe(0);
      await verifyPair(a, b);
      await a.admit(b); await b.admit(a);
      await a.send(b, "A to B verified control"); await b.sync();
      expect(b.received.at(-1)).toMatchObject({ sender: a.binding, recipient: b.binding, message: "A to B verified control" });
      expect((await a.device(c)).isVerified()).toBe(false);
      expect(c.received).toHaveLength(0);
      await verifyPair(a, c);
      // SAS and audience admission are separate even after the exact C device is natively verified.
      const beforeAdmission = transport.submitted.length;
      await expect(a.send(c, "Verified but unadmitted")).rejects.toThrow("explicitly admitted");
      expect(transport.submitted).toHaveLength(beforeAdmission);
      expect(transport.queued(c)).toBe(0);
      await verifyPair(b, c);
      for (const [left, right] of [[a, c], [b, c]]) { await left.admit(right); await right.admit(left); }
      for (const [sender, receiver] of [[a, c], [b, c], [c, a], [c, b], [b, a]]) {
        await sender.send(receiver, "Independently verified call control"); await receiver.sync();
        expect(receiver.received.at(-1)).toMatchObject({ sender: sender.binding, recipient: receiver.binding, purpose: "ephemeral-voice-proof" });
      }
      expect(c.received).toHaveLength(2);
      expect(await snapshot(dm)).toEqual(baseline);
      expect(await decryptHistory()).toEqual(history);
      for (const owner of opened) { await owner.flush(); expect((await owner.machine.roomKeyCounts()).total).toBe(0); }
      expect(transport.submitted.every((entry) => ["signing", "KeysUpload", "KeysQuery", "KeysClaim", "SignatureUpload", "ToDevice"].includes(entry.kind))).toBe(true);
      for (const owner of opened) owner.close();
      expect(await snapshot(dm)).toEqual(baseline);
      expect(await decryptHistory()).toEqual(history);
      // This deliberately logs only counts/booleans, never SAS digits, fingerprints, envelopes or keys.
      console.info("ephemeral-voice-native-proof", JSON.stringify({ devices: 3, verifiedPairs: 3, controls: 6, dmUnchanged: true, voiceClosed: opened.every((owner) => owner.closed) }));
    } finally { opened.forEach((owner) => owner.close()); dm.close(); }
  }, 30_000);

  it("loses identity and trust when the memory-only owner closes, and rejects foreign-call routing", async () => {
    await C.initAsync();
    const transport = new VoiceTransport(), foreignTransport = new VoiceTransport();
    const a = await EphemeralVoice.open(transport), b = await EphemeralVoice.open(transport);
    const foreign = await EphemeralVoice.open(foreignTransport);
    let replacement: EphemeralVoice | undefined;
    try {
      await verifyPair(a, b); await a.admit(b); await b.admit(a);
      const before = fingerprint(a.machine), binding = { ...a.binding };
      expect((await a.device(b)).isVerified()).toBe(true);
      const submitted = transport.submitted.length;
      await expect(a.admit(foreign)).rejects.toThrow("not in this call");
      await expect(a.send(foreign, "Wrong call")).rejects.toThrow("explicitly admitted");
      expect(transport.submitted).toHaveLength(submitted);
      expect(foreignTransport.queued(foreign)).toBe(0);
      a.close(); a.close();
      replacement = await EphemeralVoice.open(transport, binding);
      expect(fingerprint(replacement.machine)).not.toEqual(before);
      await replacement.query([replacement, b]);
      expect((await replacement.device(b)).isVerified()).toBe(false);
      expect(replacement.isAdmitted(b.binding)).toBe(false);
      expect((await replacement.machine.roomKeyCounts()).total).toBe(0);
      expect(replacement.machine.getVerificationRequests(new C.UserId(b.binding.user))).toHaveLength(0);
      await expect(replacement.send(b, "Prior admission must not survive")).rejects.toThrow("explicitly admitted");
    } finally { a.close(); b.close(); foreign.close(); replacement?.close(); }
  }, 20_000);
});
