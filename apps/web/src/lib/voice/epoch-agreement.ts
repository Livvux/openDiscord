import type { VoiceSnapshot } from "./contracts";
import { validateVoiceContextControl, type VoiceContextControl } from "./context-control";
import { sameVoiceParty, validateVoiceOwnerControl, voiceControlParty, type VoiceControlParty, type VoiceOwnerControl } from "./owner-control";

export class VoiceContextRejected extends Error {}

export const VOICE_AGREEMENT_LIMITS = { deadlineMs: 10_000, retainedBytes: 12_288, slots: 8, offerIntervalMs: 1_000, transitions: 8 } as const;
export type VoiceRetainedParty = readonly [string, string, string, string, string, string];
function retainedParties(audience: readonly VoiceControlParty[]): readonly VoiceRetainedParty[] {
  return Object.freeze(audience.map(p => Object.freeze([p.memberId, p.userId, p.voiceUserId, p.voiceDeviceId, p.joinNonce, p.participantIdentity] as const)));
}
function expandParty(p: VoiceRetainedParty): VoiceControlParty { return { memberId: p[0], userId: p[1], voiceUserId: p[2], voiceDeviceId: p[3], joinNonce: p[4], participantIdentity: p[5] }; }
/** Stored table uses ordinary exact strings; object-shaped parties are transient views. */
export class VoiceContextProposal {
  readonly callId: string;
  readonly generation: number;
  readonly epochId: string;
  readonly sequence: number;
  readonly reference: string;
  readonly leaderId: string;
  readonly parties: readonly VoiceRetainedParty[];
  constructor(control: VoiceContextControl, parties = retainedParties(control.audience)) {
    this.callId = control.callId; this.generation = control.generation; this.epochId = control.epochId;
    this.sequence = control.sequence; this.reference = control.reference; this.leaderId = control.leader.memberId; this.parties = parties;
    Object.freeze(this);
  }
  get audience(): readonly VoiceControlParty[] { return this.parties.map(expandParty); }
  get leader(): VoiceControlParty { const party = this.parties.find(p => p[0] === this.leaderId); if (!party) throw new Error("Missing retained voice leader."); return expandParty(party); }
}
type AcceptSlot = { senderId: string; transaction: string };
type MaterialSlot = { publisherId: string; keyId: string; reference: string; transaction: string; material: string };
type Candidate = { proposal: VoiceContextProposal; deadline: number; offered: boolean; ownConsent: boolean; accepts: AcceptSlot[]; materials: MaterialSlot[]; drained: boolean };

export function voiceContextProposal(control: VoiceContextControl, sharedTable?: readonly VoiceRetainedParty[]): VoiceContextProposal { return new VoiceContextProposal(control, sharedTable); }
export function voiceProposalPayload(proposal: VoiceContextProposal) { return { callId: proposal.callId, generation: proposal.generation, epochId: proposal.epochId, sequence: proposal.sequence, reference: proposal.reference, leaderId: proposal.leaderId, parties: proposal.parties }; }
export function sameVoiceProposal(a: VoiceContextProposal, b: VoiceContextProposal): boolean {
  return a.callId === b.callId && a.generation === b.generation && a.epochId === b.epochId && a.sequence === b.sequence && a.reference === b.reference && sameVoiceParty(a.leader, b.leader) && a.audience.length === b.audience.length && a.audience.every((party, i) => sameVoiceParty(party, b.audience[i]));
}

/** Pure ledger. Its sole production caller is its owning native-authenticating Owner. */
export class EpochAgreement {
  private partyTable: readonly VoiceRetainedParty[] = [];
  private get audience(): readonly VoiceControlParty[] { return this.partyTable.map(expandParty); }
  private externalPayload: { slots: unknown[]; proposal?: VoiceContextProposal } = { slots: [] };
  private selectionRevision = -1;
  private consent = false;
  private candidate?: Candidate;
  private installed?: VoiceContextProposal;
  private readonly highWater = new Map<string, { sequence: number; identity: string }>();
  private transitions: number[] = [];
  private lastOffer = -Infinity;
  private lastIssue = -Infinity;
  private readonly allocated = new Map<string, number>();
  private restarts: AcceptSlot[] = [];
  constructor(private snapshot: VoiceSnapshot) {}

  select(memberIds: readonly string[], revision: number, consent: boolean): void {
    if (!Number.isSafeInteger(revision) || revision <= this.selectionRevision || memberIds.length < 1 || memberIds.length > VOICE_AGREEMENT_LIMITS.slots || new Set(memberIds).size !== memberIds.length || !memberIds.includes(this.snapshot.memberId)) throw new Error("Invalid voice audience selection revision.");
    const audience = memberIds.map(id => { const member = this.snapshot.members.find(m => m.memberId === id); if (!member) throw new Error("Unknown voice audience party."); return voiceControlParty(member); }).sort((a, b) => a.memberId < b.memberId ? -1 : 1);
    this.partyTable = retainedParties(audience); this.selectionRevision = revision; this.consent = consent; this.clear();
  }
  nextSequence(now: number): number {
    this.assertSelection(this.selectionRevision);
    const leader = this.audience[0];
    if (leader.memberId !== this.snapshot.memberId || now - this.lastIssue < VOICE_AGREEMENT_LIMITS.offerIntervalMs) throw new Error("Voice local proposal rate or leader mismatch.");
    const sequence = Math.max(this.allocated.get(leader.memberId) ?? 0, this.highWater.get(leader.memberId)?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("Voice sequence exhausted.");
    const allocated = new Map(this.allocated); allocated.set(leader.memberId, sequence);
    this.budget(this.candidate, { allocated: [...allocated], lastIssue: now });
    this.allocated.set(leader.memberId, sequence); this.lastIssue = now; return sequence;
  }
  hasSelection(revision: number): boolean { return revision === this.selectionRevision && this.partyTable.length > 0 && this.consent; }
  table(revision: number): readonly VoiceRetainedParty[] { this.assertSelection(revision); return this.partyTable; }
  selected(revision: number): readonly VoiceControlParty[] { this.assertSelection(revision); return this.audience; }
  private assertSelection(revision: number): void { if (revision !== this.selectionRevision || !this.audience.length || !this.consent) throw new Error("Explicit current voice audience consent required."); }
  private identity(proposal: VoiceContextProposal): string {
    // Current snapshot fixes every full party tuple; retain only thin IDs in high-water history.
    return JSON.stringify([proposal.epochId, proposal.reference, proposal.audience.map(p => p.memberId)]);
  }
  private validated(control: VoiceContextControl, revision: number): VoiceContextProposal {
    this.assertSelection(revision); validateVoiceContextControl(control, this.snapshot, this.audience); return voiceContextProposal(control, this.partyTable);
  }
  private live(now: number): Candidate {
    const candidate = this.candidate;
    if (!candidate || (now >= candidate.deadline && !this.installed)) { this.clear(); throw new Error("Voice context negotiation expired or absent."); }
    return candidate;
  }
  setExternalPayload(slots: unknown[], proposal?: VoiceContextProposal): void {
    const previous = this.externalPayload; this.externalPayload = { slots, proposal };
    try { this.budget(this.candidate); } catch (error) { this.externalPayload = previous; throw error; }
  }
  private budget(candidate: Candidate | undefined, prospective: { highWater?: [string, { sequence: number; identity: string }][]; transitions?: number[]; lastOffer?: number; restarts?: AcceptSlot[]; allocated?: [string, number][]; lastIssue?: number } = {}): void {
    const metadata = { deadline: candidate?.deadline, offered: candidate?.offered, ownConsent: candidate?.ownConsent, drained: candidate?.drained, selectionRevision: this.selectionRevision, highWater: [...this.highWater], transitions: this.transitions, lastOffer: Number.isFinite(this.lastOffer) ? this.lastOffer : null, restarts: this.restarts, allocated: [...this.allocated], lastIssue: Number.isFinite(this.lastIssue) ? this.lastIssue : null, ...prospective };
    const shared = candidate?.proposal ?? this.externalPayload.proposal;
    const payload = { proposal: shared ? voiceProposalPayload(shared) : null, externalSlots: this.externalPayload.slots, acceptSlots: candidate?.accepts ?? [], materialSlots: candidate?.materials ?? [], scalarMetadata: metadata };
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    if ((candidate?.accepts.length ?? 0) > VOICE_AGREEMENT_LIMITS.slots || (candidate?.materials.length ?? 0) > VOICE_AGREEMENT_LIMITS.slots || metadata.highWater.length > VOICE_AGREEMENT_LIMITS.slots || metadata.allocated.length > VOICE_AGREEMENT_LIMITS.slots || bytes > VOICE_AGREEMENT_LIMITS.retainedBytes) throw new Error(`Voice context retained payload bound (${bytes} bytes).`);
  }
  private candidateFor(proposal: VoiceContextProposal, now: number): Candidate {
    if (this.candidate && now >= this.candidate.deadline && !this.installed) { this.clear(); throw new Error("Voice context negotiation expired."); }
    if (this.candidate && sameVoiceProposal(this.candidate.proposal, proposal)) return this.candidate;
    return { proposal, deadline: now + VOICE_AGREEMENT_LIMITS.deadlineMs, offered: false, ownConsent: false, accepts: [], materials: [], drained: false };
  }
  stage(control: VoiceContextControl, revision: number, now: number, deadline: number): VoiceContextProposal {
    if (control.kind !== "context-offer") throw new Error("Voice leader offer required.");
    const proposal = this.validated(control, revision), identity = this.identity(proposal), mark = this.highWater.get(proposal.leader.memberId);
    if (mark && proposal.sequence < mark.sequence) throw new VoiceContextRejected("Lower voice leader sequence rejected.");
    if (mark && proposal.sequence === mark.sequence && identity !== mark.identity) throw new Error("Voice leader sequence conflict.");
    const existing = this.candidate;
    if (mark?.sequence === proposal.sequence && (!existing || !sameVoiceProposal(existing.proposal, proposal))) throw new VoiceContextRejected("Retired voice proposal replay.");
    if (existing?.offered && sameVoiceProposal(existing.proposal, proposal)) { this.live(now); return existing.proposal; }
    if (now >= deadline) throw new Error("Voice offer capability expired.");
    const transitions = this.transitions.filter(at => now - at < VOICE_AGREEMENT_LIMITS.deadlineMs);
    if (now - this.lastOffer < VOICE_AGREEMENT_LIMITS.offerIntervalMs || transitions.length >= VOICE_AGREEMENT_LIMITS.transitions) throw new Error("Voice context transition rate bound.");
    const candidate = this.candidateFor(proposal, now);
    if (existing && !existing.offered && !sameVoiceProposal(existing.proposal, proposal)) throw new Error("Early voice acceptance proposal conflict.");
    const next = { ...candidate, deadline: Math.min(candidate.deadline, deadline), offered: true, ownConsent: true };
    const highWater = new Map(this.highWater); highWater.set(proposal.leader.memberId, { sequence: proposal.sequence, identity });
    this.budget(next, { highWater: [...highWater], transitions: [...transitions, now], lastOffer: now, restarts: [] });
    this.highWater.set(proposal.leader.memberId, { sequence: proposal.sequence, identity });
    this.transitions = [...transitions, now]; this.lastOffer = now; this.candidate = next; this.installed = undefined; this.restarts = [];
    return next.proposal;
  }
  accept(control: VoiceContextControl, revision: number, now: number, deadline: number): void {
    if (control.kind !== "context-accept" || control.sender.memberId === this.snapshot.memberId || control.recipient.memberId !== this.snapshot.memberId) throw new Error("Remote authenticated voice acceptance required.");
    const proposal = this.validated(control, revision), candidate = this.candidateFor(proposal, now);
    if (this.candidate && !sameVoiceProposal(this.candidate.proposal, proposal)) throw new Error("Voice acceptance proposal mismatch.");
    if (now >= deadline) throw new Error("Voice acceptance capability expired.");
    const prior = candidate.accepts.find(slot => slot.senderId === control.sender.memberId);
    if (prior) { if (prior.transaction !== control.transaction) throw new Error("Conflicting voice acceptance slot."); return; }
    const next = { ...candidate, deadline: Math.min(candidate.deadline, deadline), accepts: [...candidate.accepts, { senderId: control.sender.memberId, transaction: control.transaction }] };
    this.budget(next); this.candidate = next;
  }
  material(control: VoiceOwnerControl, revision: number, now: number): void {
    this.assertSelection(revision); const candidate = this.live(now);
    if (!candidate.offered || control.kind !== "material") throw new Error("Offered voice material required.");
    validateVoiceOwnerControl(control, this.snapshot, candidate.proposal.epochId, this.audience, candidate.proposal.sequence);
    const slot: MaterialSlot = { publisherId: control.publisher.memberId, keyId: control.keyId, reference: control.reference, transaction: control.transaction, material: control.material };
    const prior = candidate.materials.find(value => value.publisherId === slot.publisherId);
    if (prior) { if (JSON.stringify(prior) !== JSON.stringify(slot)) throw new Error("Conflicting pending voice material."); return; }
    const next = { ...candidate, materials: [...candidate.materials, slot] }; this.budget(next); this.candidate = next;
  }
  complete(proposal: VoiceContextProposal, revision: number, now: number): boolean {
    this.assertSelection(revision); const candidate = this.live(now);
    return candidate.offered && candidate.ownConsent && sameVoiceProposal(candidate.proposal, proposal) && this.audience.every(p => p.memberId === this.snapshot.memberId || candidate.accepts.some(slot => slot.senderId === p.memberId));
  }
  install(proposal: VoiceContextProposal, revision: number, now: number): void {
    if (!this.complete(proposal, revision, now)) throw new Error("Independent all-peer voice acceptance required.");
    this.installed = this.live(now).proposal;
  }
  drain(proposal: VoiceContextProposal, revision: number, now: number): VoiceOwnerControl[] {
    if (!this.installed || !sameVoiceProposal(this.installed, proposal) || !this.complete(proposal, revision, now)) throw new Error("Installed voice agreement required.");
    const candidate = this.live(now); if (candidate.drained) return [];
    const recipient = voiceControlParty(this.snapshot.members.find(p => p.memberId === this.snapshot.memberId)!);
    const result = candidate.materials.map(slot => { const publisher = this.audience.find(p => p.memberId === slot.publisherId)!; return { version: 1 as const, purpose: "app.opendiscord.voice.control" as const, kind: "material" as const, callId: proposal.callId, generation: proposal.generation, epochId: proposal.epochId, proposalSequence: proposal.sequence, sender: publisher, recipient, publisher, audience: [...proposal.audience], keyId: slot.keyId, reference: slot.reference, transaction: slot.transaction, material: slot.material }; });
    this.candidate = { ...candidate, drained: true, materials: [] }; return result;
  }
  restart(control: VoiceContextControl, revision: number, now: number): boolean {
    const proposal = this.validated(control, revision);
    if (control.kind !== "context-restart" || !this.installed || !sameVoiceProposal(proposal, this.installed)) throw new Error("Voice restart requires installed proposal.");
    this.live(now); const prior = this.restarts.find(p => p.senderId === control.sender.memberId);
    if (prior) { if (prior.transaction !== control.transaction) throw new Error("Conflicting voice restart slot."); return false; }
    const next = [...this.restarts, { senderId: control.sender.memberId, transaction: control.transaction }];
    if (next.length > VOICE_AGREEMENT_LIMITS.slots) throw new Error("Voice restart slot bound.");
    this.budget(this.candidate, { restarts: next }); this.restarts = next; return next.length === 1;
  }
  clear(): void { this.candidate = undefined; this.installed = undefined; this.restarts = []; this.externalPayload = { slots: [] }; }
  transition(snapshot: VoiceSnapshot): void { this.snapshot = snapshot; this.partyTable = []; this.consent = false; this.clear(); this.highWater.clear(); this.allocated.clear(); this.lastIssue = -Infinity; this.transitions = []; this.lastOffer = -Infinity; }
}
