import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { VoiceContextControl } from "@/lib/voice/context-control";
import type { VoiceAgreementEventRef, VoiceOwnerAgreementReceived } from "@/lib/voice/crypto-owner";
import type { VoiceContextProposal } from "@/lib/voice/epoch-agreement";
import { VOICE_CONTROL_EVENT, voiceControlParty, type VoiceOwnerControl } from "@/lib/voice/owner-control";
import { agreementServiceFixture, cleanupAgreementUsers, closeAgreementFixture, verifyAgreementPeers, type AgreementEndpoint } from "./fixtures/voice-agreement-service";

afterEach(closeAgreementFixture);
afterAll(cleanupAgreementUsers);
const self = (e: AgreementEndpoint) => voiceControlParty(e.snapshot.members.find(p => p.memberId === e.snapshot.memberId)!);
function control(proposal: VoiceContextProposal, sender: AgreementEndpoint, recipient: AgreementEndpoint, kind: VoiceContextControl["kind"]): VoiceContextControl {
  return { ...proposal, audience: [...proposal.audience], version: 1, purpose: VOICE_CONTROL_EVENT, sender: self(sender), recipient: self(recipient), kind, transaction: kind === "context-offer" ? proposal.reference : randomUUID() };
}
function context(values: VoiceOwnerAgreementReceived[], kind: VoiceContextControl["kind"]) {
  const result = values.find(v => v.kind === "context" && v.contextKind === kind);
  if (!result || result.kind !== "context") throw new Error("Missing authenticated context event."); return result;
}
async function acceptEvents(endpoint: AgreementEndpoint) {
  const events = await endpoint.owner.receiveAgreement();
  for (const event of events) { if (event.kind !== "context" || event.contextKind !== "context-accept") throw new Error("Expected only native authenticated accepts."); await endpoint.owner.acceptContextControl(event.ref); }
}

describe("unreachable in-band context agreement over three actual PostgreSQL native Owners", () => {
  it("independently agrees, handles accept-before-offer and material-before-last-accept, then coalesces in-band restart", async () => {
    const endpoints = await agreementServiceFixture(3);
    for (let i = 0; i < endpoints.length; i++) for (let j = i + 1; j < endpoints.length; j++) await verifyAgreementPeers(endpoints[i], endpoints[j]);
    const [a, b, c] = endpoints.sort((x, y) => x.snapshot.memberId.localeCompare(y.snapshot.memberId));
    const ids = endpoints.map(e => e.snapshot.memberId);
    for (const e of endpoints) await e.owner.selectAudience(ids, 1);
    // Only the leader creates the epoch. No participant receives setControlContext from this test.
    const local = await a.owner.createContextOffer(); await a.owner.stageOfferedContext(local.ref);
    await a.owner.sendContextControl(control(local.proposal, a, b, "context-offer"));
    const bOffer = context(await b.owner.receiveAgreement(), "context-offer"); await b.owner.stageOfferedContext(bOffer.ref);
    await b.owner.sendContextControl(control(bOffer.proposal, b, a, "context-accept"));
    await b.owner.sendContextControl(control(bOffer.proposal, b, c, "context-accept"));
    await acceptEvents(c); await acceptEvents(a);
    await a.owner.sendContextControl(control(local.proposal, a, c, "context-offer"));
    const cOffer = context(await c.owner.receiveAgreement(), "context-offer"); await c.owner.stageOfferedContext(cOffer.ref);
    expect(cOffer.proposal.epochId).toBe(local.proposal.epochId); expect(bOffer.proposal.reference).toBe(local.proposal.reference);
    for (const recipient of [b, c]) await a.owner.sendContextControl(control(local.proposal, a, recipient, "context-accept"));
    await acceptEvents(b); await acceptEvents(c);
    expect(await b.owner.contextAgreementComplete(bOffer.ref)).toBe(false);
    expect(await c.owner.contextAgreementComplete(cOffer.ref)).toBe(true);
    await c.owner.sendContextControl(control(cOffer.proposal, c, a, "context-accept")); await acceptEvents(a);
    expect(await a.owner.contextAgreementComplete(local.ref)).toBe(true); expect(await a.owner.installContext(local.ref)).toEqual([]);
    const material: VoiceOwnerControl = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: local.proposal.callId, generation: local.proposal.generation, epochId: local.proposal.epochId, sender: self(a), recipient: self(b), publisher: self(a), audience: [...local.proposal.audience], keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, 17).toString("base64") };
    await a.owner.sendControl(material);
    const pending = await b.owner.receiveAgreement(); expect(pending.map(v => v.kind)).toEqual(["pending-material"]);
    for (const event of pending) if (event.kind === "pending-material") await b.owner.retainPendingMaterial(event.ref);
    expect(await b.owner.contextAgreementComplete(bOffer.ref)).toBe(false);
    await c.owner.sendContextControl(control(cOffer.proposal, c, b, "context-accept")); await acceptEvents(b);
    expect(await b.owner.contextAgreementComplete(bOffer.ref)).toBe(true);
    expect(await b.owner.installContext(bOffer.ref)).toEqual([material]); expect(await c.owner.installContext(cOffer.ref)).toEqual([]);
    const first = control(local.proposal, b, a, "context-restart"), second = control(local.proposal, c, a, "context-restart");
    await b.owner.sendContextControl(first); await c.owner.sendContextControl(second);
    const restarts = await a.owner.receiveAgreement(), decisions: boolean[] = [];
    for (const event of restarts) { if (event.kind !== "context" || event.contextKind !== "context-restart") throw new Error("Missing native restart."); decisions.push(await a.owner.acceptContextControl(event.ref)); }
    expect(decisions).toEqual([true, false]);
    await new Promise(resolve => setTimeout(resolve, 1_010));
    const next = await a.owner.createContextOffer(); expect(next.proposal.sequence).toBe(2); expect(next.proposal.epochId).not.toBe(local.proposal.epochId);
    await a.owner.stageOfferedContext(next.ref);
    expect(await a.owner.contextAgreementComplete(next.ref)).toBe(false);
  }, 60_000);

  it("a single real Owner uses own consent with no self-SAS or encrypted self-send", async () => {
    const [a] = await agreementServiceFixture(1); await a.owner.selectAudience([a.snapshot.memberId], 1);
    const local = await a.owner.createContextOffer(); await a.owner.stageOfferedContext(local.ref);
    expect(await a.owner.contextAgreementComplete(local.ref)).toBe(true); expect(await a.owner.installContext(local.ref)).toEqual([]);
    expect(a.calls.filter(c => c.request.kind === "send")).toHaveLength(0);
  });

  it("rejects structural forged event capabilities before they can stage a context", async () => {
    const [a] = await agreementServiceFixture(1); await a.owner.selectAudience([a.snapshot.memberId], 1);
    const forged: VoiceAgreementEventRef = Object.freeze({ kind: "context-offer" });
    await expect(a.owner.stageOfferedContext(forged)).rejects.toThrow(/capability/); expect(a.fence).toHaveBeenCalledWith("native-or-schema-failure");
  });

  it("selection interleaving invalidates genuine local capability without installing its epoch", async () => {
    const [a] = await agreementServiceFixture(1); await a.owner.selectAudience([a.snapshot.memberId], 1);
    const local = await a.owner.createContextOffer(); await a.owner.selectAudience([a.snapshot.memberId], 2);
    await expect(a.owner.stageOfferedContext(local.ref)).rejects.toThrow(/capability/);
  });

  it("another Owner's genuine local proposal reference is not transferable", async () => {
    const [a, b] = await agreementServiceFixture(2);
    await a.owner.selectAudience([a.snapshot.memberId], 1); await b.owner.selectAudience([b.snapshot.memberId], 1);
    const local = await a.owner.createContextOffer(); await expect(b.owner.stageOfferedContext(local.ref)).rejects.toThrow(/capability/);
  });
});
