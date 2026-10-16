import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeVoiceControlWire, encodeVoiceControlWire } from "../src/lib/voice/control-wire";
import { voiceControlParty, VOICE_CONTROL_EVENT, type VoiceOwnerControl } from "../src/lib/voice/owner-control";
import { contextWireFixture } from "./fixtures/voice-context-wire";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("strict party-table-v1 codec through native verified Olm", () => {
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
      expect(wire.sender).toBe(sender.memberId);
      await fixture.peer.encrypt(fixture.own, wire);
      expect(await fixture.owner.receive()).toEqual([payload]);
      const invalid = { ...wire, transaction: randomUUID() };
      if (mutation === "unknown-reference") invalid.sender = randomUUID();
      if (mutation === "duplicate-table") invalid.parties = [wire.parties[0], wire.parties[0]];
      if (mutation === "unsorted-table") invalid.parties = [...wire.parties].reverse();
      if (mutation === "wrong-nonce") invalid.parties = wire.parties.map(party => party.memberId === sender.memberId ? { ...party, joinNonce: randomUUID() } : party);
      const malformed = mutation === "bad-encoding" ? { ...invalid, encoding: "party-table-v2" } : mutation === "extra-field" ? { ...invalid, audience } : invalid;
      await fixture.peer.encrypt(fixture.own, malformed);
      await expect(fixture.owner.receive()).rejects.toThrow();
      await expect(fixture.owner.flush()).rejects.toThrow("closed");
    } finally { await fixture.close(); }
  }, 30_000);
});
