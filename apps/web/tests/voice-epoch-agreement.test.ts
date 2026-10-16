import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { VoiceSnapshot } from "@/lib/voice/contracts";
import type { VoiceContextControl } from "@/lib/voice/context-control";
import { EpochAgreement, VOICE_AGREEMENT_LIMITS, voiceContextProposal } from "@/lib/voice/epoch-agreement";
import { VOICE_CONTROL_EVENT, voiceControlParty, validateVoiceOwnerControl, type VoiceOwnerControl } from "@/lib/voice/owner-control";

function fixture(count = 3, maxAccount = false) {
  const callId = randomUUID(), members = Array.from({ length: count }, (_, i) => { const memberId = randomUUID(); return { memberId, userId: maxAccount ? `${i}`.padEnd(128, "\u0001") : randomUUID(), voiceUserId: `@voice_${callId}_${memberId}:opendiscord.local`, voiceDeviceId: randomUUID(), joinNonce: randomUUID(), participantIdentity: `v1:${memberId}`, anchorDeviceId: randomUUID(), displayName: "Pure fixture", state: "waiting" as const }; }).sort((a, b) => a.memberId.localeCompare(b.memberId));
  const snapshot: VoiceSnapshot = { callId, channelId: randomUUID(), generation: 1, ...members[0], members, removals: [], serverTime: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() };
  const audience = members.map(voiceControlParty), reference = randomUUID();
  const offer: VoiceContextControl = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "context-offer", callId, generation: 1, epochId: randomUUID(), sender: audience[0], recipient: audience[0], leader: audience[0], audience, sequence: 1, reference, transaction: reference };
  const ledger = new EpochAgreement(snapshot); ledger.select(members.map(m => m.memberId), 1, true);
  const accept = (index: number): VoiceContextControl => ({ ...offer, kind: "context-accept", sender: audience[index], transaction: randomUUID() });
  const material = (index: number): VoiceOwnerControl => ({ version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId, generation: 1, epochId: offer.epochId, proposalSequence: offer.sequence, sender: audience[index], recipient: audience[0], publisher: audience[index], audience, keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, index).toString("base64") });
  return { ledger, offer, accept, material, snapshot, audience };
}

describe("pure bounded voice epoch agreement (no native-authentication claim)", () => {
  it("requires every independent remote slot, own consent cannot fill another slot", () => {
    const f = fixture(), proposal = f.ledger.stage(f.offer, 1, 0, 10_000);
    expect(f.ledger.complete(proposal, 1, 1)).toBe(false);
    const a = f.accept(1); f.ledger.accept(a, 1, 1, 10_000); f.ledger.accept(a, 1, 2, 10_000);
    expect(f.ledger.complete(proposal, 1, 3)).toBe(false);
    f.ledger.accept(f.accept(2), 1, 4, 10_000); expect(f.ledger.complete(proposal, 1, 5)).toBe(true);
  });
  it("single-party agreement completes through its explicit own consent without self-message", () => {
    const f = fixture(1), proposal = f.ledger.stage(f.offer, 1, 0, 10_000);
    expect(f.ledger.complete(proposal, 1, 1)).toBe(true); f.ledger.install(proposal, 1, 2); expect(f.ledger.drain(proposal, 1, 3)).toEqual([]);
  });
  it("accept overtaking offer does not advance high-water and preserves its original deadline", () => {
    const f = fixture(); f.ledger.accept(f.accept(1), 1, 0, 10_000);
    const proposal = f.ledger.stage(f.offer, 1, 1_000, 11_000); f.ledger.accept(f.accept(2), 1, 2_000, 12_000);
    expect(f.ledger.complete(proposal, 1, 9_999)).toBe(true);
    expect(() => f.ledger.complete(proposal, 1, 10_000)).toThrow(/expired/);
  });
  it("retains early material thinly and drains once only after all accepts and installation", () => {
    const f = fixture(), proposal = f.ledger.stage(f.offer, 1, 0, 10_000), material = f.material(1);
    f.ledger.material(material, 1, 1); f.ledger.material(material, 1, 2);
    expect(() => f.ledger.drain(proposal, 1, 3)).toThrow(/Installed/);
    f.ledger.accept(f.accept(1), 1, 4, 10_000); f.ledger.accept(f.accept(2), 1, 5, 10_000); f.ledger.install(proposal, 1, 6);
    expect(f.ledger.drain(proposal, 1, 7)).toEqual([material]); expect(f.ledger.drain(proposal, 1, 8)).toEqual([]);
  });
  it("conflicting duplicate acceptance and material slots are fatal decisions", () => {
    const f = fixture(); f.ledger.stage(f.offer, 1, 0, 10_000); const a = f.accept(1), m = f.material(1);
    f.ledger.accept(a, 1, 1, 10_000); expect(() => f.ledger.accept({ ...a, transaction: randomUUID() }, 1, 2, 10_000)).toThrow(/Conflicting/);
    f.ledger.material(m, 1, 3); expect(() => f.ledger.material({ ...m, keyId: randomUUID() }, 1, 4)).toThrow(/Conflicting/);
  });
  it("same leader high-water survives audience changes and blocks same-sequence divergent proposals", () => {
    const f = fixture(); f.ledger.stage(f.offer, 1, 0, 10_000);
    f.ledger.select(f.audience.slice(0, 2).map(p => p.memberId), 2, true);
    const changed = { ...f.offer, audience: f.audience.slice(0, 2) };
    expect(() => f.ledger.stage(changed, 2, 1_000, 11_000)).toThrow(/sequence/);
    expect(() => f.ledger.stage({ ...changed, sequence: 0 }, 2, 1_000, 11_000)).toThrow();
    expect(f.ledger.nextSequence(1_000)).toBe(2);
  });
  it("same-sequence normalized duplicate ignores recipient, divergent epoch rejects", () => {
    const f = fixture(); f.ledger.stage(f.offer, 1, 0, 10_000);
    expect(() => f.ledger.stage({ ...f.offer, recipient: f.audience[1] }, 1, 1, 10_000)).not.toThrow();
    expect(() => f.ledger.stage({ ...f.offer, epochId: randomUUID() }, 1, 1_000, 11_000)).toThrow(/sequence/);
  });
  it("supersession clears acceptance and material, and old references cannot complete", () => {
    const f = fixture(), old = f.ledger.stage(f.offer, 1, 0, 10_000); f.ledger.accept(f.accept(1), 1, 1, 10_000); f.ledger.material(f.material(1), 1, 2);
    const reference = randomUUID(), fresh = { ...f.offer, sequence: 2, epochId: randomUUID(), reference, transaction: reference };
    const proposal = f.ledger.stage(fresh, 1, 1_000, 11_000);
    expect(f.ledger.complete(proposal, 1, 1_001)).toBe(false); expect(f.ledger.complete(old, 1, 1_001)).toBe(false);
    expect(() => f.ledger.material(f.material(1), 1, 1_002)).toThrow(/proposal sequence/);
  });
  it("flood is bounded at eight transitions and duplicate offers never refresh deadline", () => {
    const f = fixture();
    for (let i = 0; i < VOICE_AGREEMENT_LIMITS.transitions; i++) { const reference = randomUUID(); f.ledger.stage({ ...f.offer, sequence: i + 1, epochId: randomUUID(), reference, transaction: reference }, 1, i * 1_000, i * 1_000 + 10_000); }
    const reference = randomUUID(); expect(() => f.ledger.stage({ ...f.offer, sequence: 9, reference, transaction: reference }, 1, 8_000, 18_000)).toThrow(/rate/);
  });
  it("eight maximum JSON-escaped account parties fit all thin slots under canonical payload cap", () => {
    const f = fixture(8, true), proposal = f.ledger.stage(f.offer, 1, 0, 10_000);
    for (let i = 0; i < 8; i++) { if (i > 0) f.ledger.accept(f.accept(i), 1, i, 10_000); f.ledger.material(f.material(i), 1, i); }
    expect(f.ledger.complete(proposal, 1, 20)).toBe(true); f.ledger.install(proposal, 1, 21); expect(f.ledger.drain(proposal, 1, 22)).toHaveLength(8);
  });
  it("restart requests coalesce and retired epoch requests cannot advance again", () => {
    const f = fixture(), proposal = f.ledger.stage(f.offer, 1, 0, 10_000);
    f.ledger.accept(f.accept(1), 1, 1, 10_000); f.ledger.accept(f.accept(2), 1, 2, 10_000); f.ledger.install(proposal, 1, 3);
    const restart = { ...f.accept(1), kind: "context-restart" as const };
    expect(f.ledger.restart(restart, 1, 20_000)).toBe(true); expect(f.ledger.restart(restart, 1, 20_001)).toBe(false);
    expect(f.ledger.restart({ ...f.accept(2), kind: "context-restart" }, 1, 20_002)).toBe(false);
    const reference = randomUUID(); f.ledger.stage({ ...f.offer, sequence: 2, epochId: randomUUID(), reference, transaction: reference }, 1, 21_000, 31_000);
    expect(() => f.ledger.restart(restart, 1, 21_001)).toThrow(/installed/);
  });
  it("generation resets exactly while selection consent and references are invalidated", () => {
    const f = fixture(); f.ledger.stage(f.offer, 1, 0, 10_000); f.ledger.transition({ ...f.snapshot, generation: 2 });
    expect(() => f.ledger.complete(voiceContextProposal(f.offer), 1, 1)).toThrow(/consent/);
    f.ledger.select(f.audience.map(p => p.memberId), 2, true); expect(f.ledger.nextSequence(1_000)).toBe(1);
    expect(() => f.ledger.stage(f.offer, 2, 1_000, 11_000)).toThrow(/Stale/);
  });
  it("prospective overflow cannot commit leader sequence or transition metadata", () => {
    const f = fixture(); f.ledger.setExternalPayload(["x".repeat(11_500)]);
    expect(() => f.ledger.stage(f.offer, 1, 0, 10_000)).toThrow(/retained payload/);
    f.ledger.setExternalPayload([]); expect(() => f.ledger.stage(f.offer, 1, 0, 10_000)).not.toThrow();
  });
  it.each(["material", "prepared", "key-ready"] as const)("product %s requires the exact proposal sequence while primitive schema remains compatible", kind => {
    const f = fixture(), material = f.material(1);
    const raw: VoiceOwnerControl = kind === "material" ? material : { version: material.version, purpose: material.purpose, kind, callId: material.callId, generation: material.generation, epochId: material.epochId, audience: material.audience, sender: material.sender, recipient: material.recipient, publisher: material.recipient, keyId: material.keyId, reference: material.reference, transaction: material.transaction, proposalSequence: 1 };
    expect(validateVoiceOwnerControl(raw, f.snapshot, f.offer.epochId, f.audience, 1)).toEqual(raw);
    const { proposalSequence: omitted, ...legacy } = raw; expect(omitted).toBe(1);
    expect(() => validateVoiceOwnerControl(legacy, f.snapshot, f.offer.epochId, f.audience, 1)).toThrow(/proposal sequence/);
    expect(() => validateVoiceOwnerControl({ ...raw, proposalSequence: 2 }, f.snapshot, f.offer.epochId, f.audience, 1)).toThrow(/proposal sequence/);
    expect(() => validateVoiceOwnerControl(legacy, f.snapshot, f.offer.epochId, f.audience)).not.toThrow();
  });

});
