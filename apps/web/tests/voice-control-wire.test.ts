import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeVoiceControlWire, encodeVoiceControlWire } from "../src/lib/voice/control-wire";
import { voiceControlParty, VOICE_CONTROL_EVENT, type VoiceOwnerControl } from "../src/lib/voice/owner-control";
import { contextWireFixture } from "./fixtures/voice-context-wire";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("strict party-table-v2 codec through native verified Olm", () => {
  for (const mutation of ["unknown-reference", "duplicate-table", "unsorted-table", "bad-encoding", "extra-field", "wrong-nonce"] as const) it(`accepts genuine compact material before rejecting ${mutation}`, async () => {
    const fixture = await contextWireFixture(async () => undefined, "uuid", false, 2);
    try {
      await fixture.owner.admit(fixture.remote.memberId);
      const epochId = randomUUID(), audience = fixture.snapshot.members.map(voiceControlParty);
      await fixture.owner.setControlContext(epochId, audience.map(party => party.memberId));
      const sender = voiceControlParty(fixture.remote), recipient = voiceControlParty(fixture.own);
      const payload: VoiceOwnerControl = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: fixture.snapshot.callId, generation: 1, epochId, sender, recipient, publisher: sender, audience, keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, 7).toString("base64") };
      const wire = encodeVoiceControlWire(payload);
      expect(decodeVoiceControlWire(wire)).toEqual(payload);
      expect(wire).not.toHaveProperty("audience");
      expect(wire.parties[wire.sender][0]).toBe(sender.memberId);
      await fixture.peer.encrypt(fixture.own, wire);
      expect(await fixture.owner.receive()).toEqual([payload]);
      const invalid = { ...wire, transaction: randomUUID() };
      if (mutation === "unknown-reference") invalid.sender = 7;
      if (mutation === "duplicate-table") invalid.parties = [wire.parties[0], wire.parties[0]];
      if (mutation === "unsorted-table") invalid.parties = [...wire.parties].reverse();
      if (mutation === "wrong-nonce") invalid.parties = wire.parties.map(party => party[0] === sender.memberId ? [party[0], party[1], party[2], randomUUID()] : party);
      const malformed = mutation === "bad-encoding" ? { ...invalid, encoding: "party-table-v3" } : mutation === "extra-field" ? { ...invalid, audience } : invalid;
      await fixture.peer.encrypt(fixture.own, malformed);
      await expect(fixture.owner.receive()).rejects.toThrow();
      await expect(fixture.owner.flush()).rejects.toThrow("closed");
    } finally { await fixture.close(); }
  }, 30_000);
});

function canonical(): VoiceOwnerControl {
  const callId = randomUUID();
  const audience = [0, 1].map(() => {
    const memberId = randomUUID();
    return { memberId, userId: randomUUID(), voiceUserId: `@voice_${callId}_${memberId}:opendiscord.local`, voiceDeviceId: randomUUID(), joinNonce: randomUUID(), participantIdentity: `v1:${memberId}` };
  }).sort((a, b) => a.memberId.localeCompare(b.memberId));
  return { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId, generation: 1, epochId: randomUUID(), sender: audience[0], recipient: audience[1], publisher: audience[0], audience, keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, 7).toString("base64") };
}
describe("party-table-v2 pure JSON boundaries, never submitted to native code", () => {
  for (const field of ["voiceUserId", "participantIdentity"] as const) it(`rejects a nonderived ${field} before encoding`, () => {
    const value = canonical();
    value.audience[0][field] = "wrong-but-schema-valid";
    expect(() => encodeVoiceControlWire(value)).toThrow("derived party mismatch");
  });
  for (const invalid of ["noncanonical-base64", "odd-bytes", "oversized-bytes", "invalid-tuple", "fractional-index", "negative-index", "missing-index", "coerced-index"] as const) it(`rejects ${invalid} as safe JSON`, () => {
    const wire = encodeVoiceControlWire(canonical());
    const first = wire.parties[0];
    const encodedAccount = invalid === "noncanonical-base64" ? "AGF=" : invalid === "odd-bytes" ? "YQ==" : Buffer.alloc(258, 1).toString("base64");
    const altered = invalid.endsWith("index")
      ? { ...wire, sender: invalid === "fractional-index" ? 0.5 : invalid === "negative-index" ? -1 : invalid === "coerced-index" ? "0" : 7 }
      : { ...wire, parties: invalid === "invalid-tuple" ? [[first[0], first[1], first[2]], wire.parties[1]] : [[first[0], encodedAccount, first[2], first[3]], wire.parties[1]] };
    expect(() => decodeVoiceControlWire(JSON.parse(JSON.stringify(altered)))).toThrow();
  });
  for (const exact of ["界".repeat(128), "\u0001".repeat(128), "\ud800", "a\udfff界"]) it("preserves exact UTF16 code units without normalization", () => {
    const value = canonical();
    value.audience[0].userId = exact;
    const wire = encodeVoiceControlWire(value);
    expect(Buffer.from(wire.parties[0][1], "base64").length).toBe(exact.length * 2);
    expect(decodeVoiceControlWire(wire)).toEqual(value);
  });
});
