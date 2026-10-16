import { randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceContextControl } from "@/lib/voice/context-control";
import { VoiceGenerationInterrupted, type VoiceAgreementEventRef, type VoiceOwnerAgreementReceived } from "@/lib/voice/crypto-owner";
import { VoiceContextRejected } from "@/lib/voice/epoch-agreement";
import { encodeVoiceControlWire } from "@/lib/voice/control-wire";
import type { VoiceContextProposal } from "@/lib/voice/epoch-agreement";
import { VOICE_CONTROL_EVENT, voiceControlParty, type VoiceOwnerControl } from "@/lib/voice/owner-control";
import { agreementServiceFixture, cleanupAgreementUsers, closeAgreementFixture, verifyAgreementPeers, openAgreementPublicPeer, verifyAgreementPublicPeer, type AgreementEndpoint } from "./fixtures/voice-agreement-service";

afterEach(closeAgreementFixture);
afterAll(cleanupAgreementUsers);
const self = (e: AgreementEndpoint) => voiceControlParty(e.snapshot.members.find(p => p.memberId === e.snapshot.memberId)!);
function control(proposal: VoiceContextProposal, sender: AgreementEndpoint, recipient: AgreementEndpoint, kind: VoiceContextControl["kind"]): VoiceContextControl {
  return { callId: proposal.callId, generation: proposal.generation, epochId: proposal.epochId, sequence: proposal.sequence, reference: proposal.reference, leader: proposal.leader, audience: [...proposal.audience], version: 1, purpose: VOICE_CONTROL_EVENT, sender: self(sender), recipient: self(recipient), kind, transaction: kind === "context-offer" ? proposal.reference : randomUUID() };
}
function context(values: VoiceOwnerAgreementReceived[], kind: VoiceContextControl["kind"]) {
  const result = values.find(v => v.kind === "context" && v.contextKind === kind);
  if (!result || result.kind !== "context") throw new Error("Missing authenticated context event."); return result;
}
async function acceptEvents(endpoint: AgreementEndpoint) {
  const events = await endpoint.owner.receiveAgreement();
  for (const event of events) { if (event.kind !== "context" || event.contextKind !== "context-accept") throw new Error("Expected only native authenticated accepts."); await endpoint.owner.acceptContextControl(event.ref); }
}

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function agreePair(a: AgreementEndpoint, b: AgreementEndpoint, local: Awaited<ReturnType<AgreementEndpoint["owner"]["createContextOffer"]>>) {
  await a.owner.stageOfferedContext(local.ref); await a.owner.sendContextControl(control(local.proposal, a, b, "context-offer"));
  const remote = context(await b.owner.receiveAgreement(), "context-offer"); await b.owner.stageOfferedContext(remote.ref);
  await a.owner.sendContextControl(control(local.proposal, a, b, "context-accept")); await b.owner.sendContextControl(control(remote.proposal, b, a, "context-accept"));
  await acceptEvents(a); await acceptEvents(b); await a.owner.installContext(local.ref); await b.owner.installContext(remote.ref);
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
    const material: VoiceOwnerControl = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: local.proposal.callId, generation: local.proposal.generation, epochId: local.proposal.epochId, proposalSequence: local.proposal.sequence, sender: self(a), recipient: self(b), publisher: self(a), audience: [...local.proposal.audience], keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, 17).toString("base64") };
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
  it.each(["equal-proposal", "old-material", "prepared", "key-ready"] as const)("rejects lower replay without mutation, preserves current traffic, and fences %s", async (negative) => {
    const [a, b] = await agreementServiceFixture(2, 1, undefined, true), peer = await openAgreementPublicPeer(b);
    await verifyAgreementPublicPeer(a, b, peer); await a.owner.selectAudience(a.snapshot.members.map(m => m.memberId), 1);
    const audience = a.snapshot.members.map(voiceControlParty).sort((x, y) => x.memberId.localeCompare(y.memberId));
    const offer = (sequence: number): VoiceContextControl => { const reference = randomUUID(); return { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "context-offer", callId: a.snapshot.callId, generation: a.snapshot.generation, epochId: randomUUID(), sender: self(b), recipient: self(a), audience, leader: self(b), sequence, reference, transaction: reference }; };
    async function agree(value: VoiceContextControl) {
      await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, encodeVoiceControlWire(value));
      const offered = context(await a.owner.receiveAgreement(), "context-offer"); await a.owner.stageOfferedContext(offered.ref);
      await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, encodeVoiceControlWire({ ...value, kind: "context-accept", transaction: randomUUID() })); await acceptEvents(a);
      expect(await a.owner.contextAgreementComplete(offered.ref)).toBe(true); await a.owner.installContext(offered.ref);
    }
    const first = offer(1); await agree(first);
    await new Promise(resolve => setTimeout(resolve, 1_010));
    const second = { ...offer(2), epochId: first.epochId };
    const material: VoiceOwnerControl = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: second.callId, generation: second.generation, epochId: second.epochId, proposalSequence: second.sequence, audience, sender: self(b), recipient: self(a), publisher: self(b), keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, 23).toString("base64") };
    const beforeBatch = a.fence.mock.calls.length;
    await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, encodeVoiceControlWire(second));
    await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, encodeVoiceControlWire(material));
    const offeredBatch = await a.owner.receiveAgreement(), staged = context(offeredBatch, "context-offer");
    expect(offeredBatch.map(e => e.kind)).toEqual(["context", "pending-material"]); expect(a.fence.mock.calls).toHaveLength(beforeBatch);
    await a.owner.stageOfferedContext(staged.ref);
    for (const event of offeredBatch) if (event.kind === "pending-material") await a.owner.retainPendingMaterial(event.ref);
    expect(await a.owner.contextAgreementComplete(staged.ref)).toBe(false);
    await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, encodeVoiceControlWire({ ...second, kind: "context-accept", transaction: randomUUID() })); await acceptEvents(a);
    expect(await a.owner.installContext(staged.ref)).toEqual([material]);
    await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, encodeVoiceControlWire(material)); expect(await a.owner.receiveAgreement()).toEqual([{ kind: "media", control: material }]);
    const fences = a.fence.mock.calls.length;
    await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, encodeVoiceControlWire(first)); await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, encodeVoiceControlWire(material));
    const batch = await a.owner.receiveAgreement(), lower = context(batch, "context-offer");
    expect(batch.filter(e => e.kind === "media")).toEqual([{ kind: "media", control: material }]);
    await expect(a.owner.stageOfferedContext(lower.ref)).rejects.toBeInstanceOf(VoiceContextRejected); expect(a.fence.mock.calls).toHaveLength(fences);
    await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, encodeVoiceControlWire(material)); expect(await a.owner.receiveAgreement()).toEqual([{ kind: "media", control: material }]);
    if (negative === "equal-proposal") {
      await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, encodeVoiceControlWire({ ...second, epochId: randomUUID() }));
      const divergent = context(await a.owner.receiveAgreement(), "context-offer"); await expect(a.owner.stageOfferedContext(divergent.ref)).rejects.toThrow(/sequence conflict/);
    } else {
      const payload: VoiceOwnerControl = negative === "old-material" ? { ...material, proposalSequence: first.sequence } : { version: 1, purpose: VOICE_CONTROL_EVENT, kind: negative, callId: second.callId, generation: second.generation, epochId: second.epochId, proposalSequence: first.sequence, audience, sender: self(b), recipient: self(a), publisher: self(a), keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID() };
      await peer.encrypt(a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!, encodeVoiceControlWire(payload)); await expect(a.owner.receiveAgreement()).rejects.toThrow(/proposal sequence/);
    }
    expect(a.fence).toHaveBeenCalledWith("native-or-schema-failure");
  }, 60_000);

  it.each(["selection", "stage"] as const)("holds actual ACK and refuses stale media after %s fence", async kind => {
    const endpoints = await agreementServiceFixture(2); await verifyAgreementPeers(endpoints[0], endpoints[1]);
    const [a, b] = endpoints.sort((x, y) => x.snapshot.memberId.localeCompare(y.snapshot.memberId)), ids = endpoints.map(e => e.snapshot.memberId);
    await a.owner.selectAudience(ids, 1); await b.owner.selectAudience(ids, 1);
    const first = await a.owner.createContextOffer(); await agreePair(a, b, first);
    const material: VoiceOwnerControl = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: first.proposal.callId, generation: first.proposal.generation, epochId: first.proposal.epochId, proposalSequence: first.proposal.sequence, sender: self(b), recipient: self(a), publisher: self(b), audience: [...first.proposal.audience], keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, 29).toString("base64") };
    await b.owner.sendControl(material); expect(await a.owner.receiveAgreement()).toEqual([{ kind: "media", control: material }]);
    await new Promise(resolve => setTimeout(resolve, 1_010)); const next = await a.owner.createContextOffer();
    const entered = gate(), release = gate(); let held = false;
    a.after = async input => { if (input.request.kind === "ack" && !held) { held = true; entered.resolve(); await release.promise; } };
    await b.owner.sendControl(material); const receiving = a.owner.receiveAgreement(); await entered.promise;
    try {
      const fences = a.fence.mock.calls.length;
      if (kind === "selection") { const selected = a.owner.selectAudience(ids, 2); expect(a.fence.mock.calls.length).toBeGreaterThan(fences); await selected; }
      else await a.owner.stageOfferedContext(next.ref);
      release.resolve(); await expect(receiving).rejects.toBeInstanceOf(VoiceGenerationInterrupted);
      expect(a.fence).not.toHaveBeenCalledWith("native-or-schema-failure"); expect(a.fence).not.toHaveBeenCalledWith("transport-or-schema-failure");
      a.after = undefined;
      let fresh = next;
      if (kind === "selection") { await new Promise(resolve => setTimeout(resolve, 1_010)); fresh = await a.owner.createContextOffer(); expect(fresh.proposal.sequence).toBe(3); }
      await agreePair(a, b, fresh);
      const current = { ...material, epochId: fresh.proposal.epochId, proposalSequence: fresh.proposal.sequence };
      await b.owner.sendControl(current); expect(await a.owner.receiveAgreement()).toEqual([{ kind: "media", control: current }]);
    } finally { release.resolve(); a.after = undefined; }
  }, 60_000);

  it.each(["predispatch", "current-transport-failure"] as const)("settles genuine observed native work safely across %s media fence", async kind => {
    const endpoints = await agreementServiceFixture(2); await verifyAgreementPeers(endpoints[0], endpoints[1]);
    const [a, b] = endpoints.sort((x, y) => x.snapshot.memberId.localeCompare(y.snapshot.memberId)), ids = endpoints.map(e => e.snapshot.memberId);
    await a.owner.selectAudience(ids, 1); await b.owner.selectAudience(ids, 1); const local = await a.owner.createContextOffer(); await agreePair(a, b, local);
    const material: VoiceOwnerControl = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: local.proposal.callId, generation: local.proposal.generation, epochId: local.proposal.epochId, proposalSequence: local.proposal.sequence, sender: self(a), recipient: self(b), publisher: self(a), audience: [...local.proposal.audience], keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, 31).toString("base64") };
    await a.owner.sendControl(material); expect(await b.owner.receiveAgreement()).toEqual([{ kind: "media", control: material }]);
    if (kind === "predispatch") {
      const sent = a.calls.filter(c => c.request.kind === "send").length, retired = a.calls.filter(c => c.request.kind === "retire").length;
      const encrypt = C.Device.prototype.encryptToDeviceEvent; let selection: Promise<void> | undefined;
      vi.spyOn(C.Device.prototype, "encryptToDeviceEvent").mockImplementation(async function(this: C.Device, ...args) {
        const result = await encrypt.apply(this, args); selection = a.owner.selectAudience(ids, 2); return result;
      });
      await expect(a.owner.sendControl(material)).rejects.toBeInstanceOf(VoiceGenerationInterrupted); await selection;
      expect(a.calls.filter(c => c.request.kind === "send")).toHaveLength(sent); expect(a.calls.filter(c => c.request.kind === "retire")).toHaveLength(retired + 1);
      expect(a.fence).not.toHaveBeenCalledWith("transport-or-completion-failure");
    } else {
      const entered = gate(), release = gate(); let held = false;
      a.after = async input => { if (input.request.kind === "send" && !held) { held = true; entered.resolve(); await release.promise; throw new Error("Current media transport failed after real service commit."); } };
      const sending = a.owner.sendControl(material); await entered.promise;
      try { await a.owner.selectAudience(ids, 2); release.resolve(); await expect(sending).rejects.toThrow(/Current media transport failed/); expect(a.fence).toHaveBeenCalledWith("native-or-schema-failure"); }
      finally { release.resolve(); a.after = undefined; }
    }
  }, 60_000);

  it("ACKs an early authenticated offer without authority while a third Owner still needs SAS/admission/selection", async () => {
    const endpoints = (await agreementServiceFixture(3)).sort((x, y) => x.snapshot.memberId.localeCompare(y.snapshot.memberId));
    const [a, b, c] = endpoints, ids = endpoints.map(e => e.snapshot.memberId);
    await verifyAgreementPeers(a, b); await verifyAgreementPeers(a, c);
    // A has independently admitted the complete roster. B and C still need each other.
    await a.owner.selectAudience(ids, 1); const early = await a.owner.createContextOffer(); await a.owner.stageOfferedContext(early.ref);
    await a.owner.sendContextControl(control(early.proposal, a, b, "context-offer"));
    expect(await b.owner.receiveAgreement()).toEqual([{ kind: "context-not-ready", contextKind: "context-offer", senderId: a.snapshot.memberId, reason: "local-consent-pending" }]);
    expect(b.fence).not.toHaveBeenCalledWith("native-or-schema-failure");
    // The same real mailbox must remain usable for the remaining genuine SAS exchange.
    await verifyAgreementPeers(b, c);
    for (const endpoint of endpoints) await endpoint.owner.selectAudience(ids, 2);
    await new Promise(resolve => setTimeout(resolve, 1_010)); const fresh = await a.owner.createContextOffer();
    expect(fresh.proposal.sequence).toBe(2); expect(fresh.proposal.epochId).not.toBe(early.proposal.epochId); await a.owner.stageOfferedContext(fresh.ref);
    const refs = new Map<AgreementEndpoint, VoiceAgreementEventRef>([[a, fresh.ref]]);
    for (const endpoint of [b, c]) { await a.owner.sendContextControl(control(fresh.proposal, a, endpoint, "context-offer")); const event = context(await endpoint.owner.receiveAgreement(), "context-offer"); await endpoint.owner.stageOfferedContext(event.ref); refs.set(endpoint, event.ref); }
    for (const sender of endpoints) for (const recipient of endpoints) if (sender !== recipient) await sender.owner.sendContextControl(control(fresh.proposal, sender, recipient, "context-accept"));
    for (const endpoint of endpoints) { await acceptEvents(endpoint); const ref = refs.get(endpoint)!; expect(await endpoint.owner.contextAgreementComplete(ref)).toBe(true); await endpoint.owner.installContext(ref); }
    const material: VoiceOwnerControl = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: fresh.proposal.callId, generation: fresh.proposal.generation, epochId: fresh.proposal.epochId, proposalSequence: fresh.proposal.sequence, sender: self(a), recipient: self(b), publisher: self(a), audience: [...fresh.proposal.audience], keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, 37).toString("base64") };
    await a.owner.sendControl(material); expect(await b.owner.receiveAgreement()).toEqual([{ kind: "media", control: material }]);
  }, 60_000);

  it.each(["nonleader-offer", "wrong-recipient"] as const)("rejects genuine native %s only after successful current controls", async negative => {
    const [a, b] = await agreementServiceFixture(2, 1, undefined, false, true), peer = await openAgreementPublicPeer(b);
    await verifyAgreementPublicPeer(a, b, peer); await a.owner.selectAudience(a.snapshot.members.map(m => m.memberId), 1);
    const local = await a.owner.createContextOffer(); await a.owner.stageOfferedContext(local.ref);
    await a.owner.sendContextControl(control(local.proposal, a, b, "context-offer")); await peer.receive();
    const ownMember = a.snapshot.members.find(m => m.memberId === a.snapshot.memberId)!;
    await peer.encrypt(ownMember, encodeVoiceControlWire(control(local.proposal, b, a, "context-accept"))); await acceptEvents(a); await a.owner.installContext(local.ref);
    const material: VoiceOwnerControl = { version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: local.proposal.callId, generation: local.proposal.generation, epochId: local.proposal.epochId, proposalSequence: local.proposal.sequence, sender: self(b), recipient: self(a), publisher: self(b), audience: [...local.proposal.audience], keyId: randomUUID(), reference: randomUUID(), transaction: randomUUID(), material: Buffer.alloc(32, 41).toString("base64") };
    await peer.encrypt(ownMember, encodeVoiceControlWire(material)); expect(await a.owner.receiveAgreement()).toEqual([{ kind: "media", control: material }]);
    const reference = randomUUID();
    const forged = negative === "nonleader-offer" ? { ...control(local.proposal, b, a, "context-offer"), sequence: local.proposal.sequence + 1, reference, transaction: reference, epochId: randomUUID() } : control(local.proposal, b, b, "context-accept");
    await peer.encrypt(ownMember, encodeVoiceControlWire(forged)); await expect(a.owner.receiveAgreement()).rejects.toThrow(negative === "nonleader-offer" ? /leader mismatch/ : /sender\/admission mismatch/);
    expect(a.fence).toHaveBeenCalledWith("native-or-schema-failure");
  }, 60_000);

});
