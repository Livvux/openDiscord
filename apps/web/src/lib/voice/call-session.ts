import { readExistingDmEnrollment } from "../dm/enrollment";
import { createVoiceHttpClient, VoiceHttpError, voiceHttpSnapshotSchema } from "./http-client";
import { acquireVoiceOwnerGuard, releaseUnusedVoiceOwnerGuard, type VoiceOwnerGuard } from "./owner-guard";
import { sameVoiceParty, voiceControlParty, VOICE_CONTROL_EVENT, type VoiceControlParty, type VoiceOwnerControl } from "./owner-control";
import type { VoiceBinding, VoiceSnapshot } from "./contracts";
import type { VoiceAgreementEventRef, VoiceOwnerAgreementReceived, VoiceOwnerTransport, VoiceProductOwnerPort, VoiceSasState } from "./crypto-owner";
import type { VoiceContextProposal } from "./epoch-agreement";
import type { VoiceContextControl } from "./context-control";

const POLL_MS = 1_000, HEARTBEAT_MS = 10_000, ATTEMPT_MS = 10_000, WINDOW_MS = 60_000;
// All HTTP actions share this budget. Optional work leaves 18 slots for heartbeat,
// conflict resolution and leave; the total 180 still leaves 60 server slots/minute.
const HTTP_LIMIT = 180, PRIORITY_RESERVE = 18;
type Priority = "ordinary" | "priority";
export class VoiceCallSessionError extends Error {
  constructor(readonly code: "browser-unavailable" | "messaging-setup-required" | "ended" | "lease-expired" | "context-expired" | "budget-exhausted" | "not-ready" | "binding-changed" | "generation-conflict" | "retirement-conflict" | "unsupported-media") { super(`Voice call ${code}.`); this.name = "VoiceCallSessionError"; }
}
export class VoiceRetirementConflict extends VoiceCallSessionError { constructor() { super("retirement-conflict"); this.name = "VoiceRetirementConflict"; } }
export type VoiceCallState = "verifying" | "waiting" | "negotiating" | "agreed" | "retry-required" | "ended";
type VoiceSasView = Readonly<Omit<VoiceSasState, "emojiIndices"> & { emojiIndices: readonly number[] | null }>;
export type VoiceCallView = Readonly<{
  state: VoiceCallState; roster: readonly Readonly<VoiceSnapshot["members"][number]>[];
  fenceRevision: number; generation: number; selfMemberId: string; admittedMemberIds: readonly string[]; sas: readonly VoiceSasView[];
  localConsentPending: boolean; error?: string;
}>;
export type VoiceCallOptions = {
  accountId: string; sessionId: string; channelId: string; consent: true;
  /** Must throw after account/session replacement or provider destruction. */
  assertSessionCurrent(): void;
  fetch?: typeof fetch;
};
type Attempt = { deadline: number; revision: number; ref?: VoiceAgreementEventRef; proposal?: VoiceContextProposal; installed: boolean };
type Grant = { snapshot: VoiceSnapshot; start: number; deadline: number };

/** Unactivated browser control lifetime. No media, React singleton, DM enrollment or persistence. */
export class CallSession {
  private readonly lifetime = new AbortController();
  private readonly http;
  private readonly listeners = new Set<() => void>();
  private readonly requests: number[] = [];
  private readonly admitted = new Map<string, VoiceControlParty>();
  private owner?: VoiceProductOwnerPort;
  private isInterrupted: (error: unknown) => boolean = () => false;
  private guard?: VoiceOwnerGuard;
  private secret = "";
  private authority?: Grant;
  private state: VoiceCallState = "verifying";
  private error?: string;
  private sas: VoiceSasState[] = [];
  private localConsentPending = false;
  private selectionRevision = 0;
  private fenceRevision = 0;
  private attempt?: Attempt;
  private stopped = false;
  private cleanup?: Promise<void>;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private contextTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private pollFlight?: Promise<void>;
  private heartbeatFlight?: Promise<Grant>;
  private discovery?: Promise<Grant>;
  private transitionActive = false;
  private transitionTarget?: VoiceSnapshot;
  private transitionFlight?: Promise<void>;
  private lastPollStart = -Infinity;
  private actionFlight?: Promise<void>;
  private view: VoiceCallView = Object.freeze({ state: "verifying", roster: [], fenceRevision: 0, generation: 0, selfMemberId: "", admittedMemberIds: [], sas: [], localConsentPending: false });
  private readonly resume = () => { try { this.checkCurrent(); } catch { /* checkCurrent closes synchronously */ } };
  private constructor(private readonly options: VoiceCallOptions) { this.http = createVoiceHttpClient({ fetch: options.fetch }); }

  static async create(options: VoiceCallOptions): Promise<CallSession> {
    if (typeof window === "undefined") throw new VoiceCallSessionError("browser-unavailable");
    options.assertSessionCurrent();
    if (options.consent !== true || !options.accountId || !options.sessionId) throw new VoiceCallSessionError("not-ready");
    let anchor = readExistingDmEnrollment(options.accountId);
    if (!anchor) throw new VoiceCallSessionError("messaging-setup-required");
    const session = new CallSession(options);
    try {
      session.guard = await acquireVoiceOwnerGuard(options.accountId);
      session.assertAlive();
      session.secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
      const start = session.issue("priority");
      const snapshot = await session.http.join({ channelId: options.channelId, joinNonce: crypto.randomUUID(), voiceDeviceId: crypto.randomUUID(), enrollmentSecret: session.secret, consent: true }, anchor, session.lifetime.signal);
      anchor = null;
      session.acceptGrant(session.grant(snapshot, start));
      // WASM/native module evaluation happens only after explicit browser join consent.
      const { createVoiceProductOwner, VoiceGenerationInterrupted } = await import("./crypto-owner");
      session.isInterrupted = error => error instanceof VoiceGenerationInterrupted;
      session.checkCurrent();
      session.owner = await createVoiceProductOwner({ accountId: options.accountId, guard: session.guard, snapshot, lifetime: { signal: session.lifetime.signal, assertCurrent: () => session.checkCurrent() }, transport: session.transport, onFence: reason => session.ownerFence(reason) });
      session.checkCurrent();
      window.addEventListener?.("pageshow", session.resume);
      globalThis.document?.addEventListener("visibilitychange", session.resume);
      session.emit(); session.schedulePoll(); session.scheduleHeartbeat();
      return session;
    } catch (error) { anchor = null; await session.close("bootstrap-failed"); throw error; }
  }
  getSnapshot = (): VoiceCallView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private emit(): void {
    const snapshot = this.authority?.snapshot;
    this.view = Object.freeze({ state: this.state, fenceRevision: this.fenceRevision, roster: Object.freeze((snapshot?.members ?? []).map(member => Object.freeze({ ...member }))), generation: snapshot?.generation ?? 0, selfMemberId: snapshot?.memberId ?? "", admittedMemberIds: Object.freeze([...this.admitted.keys()].sort()), sas: Object.freeze(this.sas.map(value => Object.freeze({ ...value, peer: Object.freeze({ ...value.peer }), emojiIndices: value.emojiIndices ? Object.freeze([...value.emojiIndices]) : null }))), localConsentPending: this.localConsentPending, ...(this.error ? { error: this.error } : {}) });
    for (const listener of this.listeners) { try { listener(); } catch { /* Render observers cannot alter native control lifetime. */ } }
  }
  private assertAlive(): void {
    if (this.stopped || this.lifetime.signal.aborted) throw new VoiceCallSessionError("ended");
    try { this.options.assertSessionCurrent(); } catch (error) { void this.close("session-changed"); throw error; }
  }
  checkCurrent(): void {
    this.assertAlive();
    if (this.authority && performance.now() >= this.authority.deadline) { void this.close("lease-expired"); throw new VoiceCallSessionError("lease-expired"); }
  }
  private binding(snapshot = this.authority?.snapshot): VoiceBinding {
    if (!snapshot) throw new VoiceCallSessionError("not-ready");
    return { callId: snapshot.callId, memberId: snapshot.memberId, joinNonce: snapshot.joinNonce, expectedGeneration: snapshot.generation };
  }
  private prune(): void { const before = performance.now() - WINDOW_MS; while (this.requests.length && this.requests[0] <= before) this.requests.shift(); }
  private issue(priority: Priority, allowStopped = false): number {
    if (!allowStopped) this.checkCurrent();
    this.prune();
    if (this.requests.length >= (priority === "priority" ? HTTP_LIMIT : HTTP_LIMIT - PRIORITY_RESERVE)) throw new VoiceCallSessionError("budget-exhausted");
    const start = performance.now(); this.requests.push(start); return start;
  }
  private negotiationCapacity(): void {
    this.prune();
    // A full fanout can emit claim/send and native signature/control followups.
    // This conservative admission bound is not a throughput promise for eight peers.
    const needed = Math.max(8, (this.authority!.snapshot.members.length - 1) * 8 + 8);
    if (this.requests.length + needed > HTTP_LIMIT - PRIORITY_RESERVE) throw new VoiceCallSessionError("budget-exhausted");
  }
  private grant(raw: VoiceSnapshot, start: number): Grant {
    this.assertAlive();
    const snapshot = voiceHttpSnapshotSchema.parse(raw), own = snapshot.members.find(member => member.memberId === snapshot.memberId);
    if (snapshot.channelId !== this.options.channelId || own?.userId !== this.options.accountId) throw new VoiceCallSessionError("binding-changed");
    const old = this.authority?.snapshot;
    if (old && (snapshot.callId !== old.callId || snapshot.memberId !== old.memberId || snapshot.joinNonce !== old.joinNonce || snapshot.voiceUserId !== old.voiceUserId || snapshot.voiceDeviceId !== old.voiceDeviceId || snapshot.participantIdentity !== old.participantIdentity)) throw new VoiceCallSessionError("binding-changed");
    if (old && snapshot.generation === old.generation && (snapshot.members.length !== old.members.length || snapshot.members.some(member => !old.members.some(prior => sameVoiceParty(voiceControlParty(member), voiceControlParty(prior)))))) throw new VoiceCallSessionError("binding-changed");
    const duration = Date.parse(snapshot.leaseExpiresAt) - Date.parse(snapshot.serverTime);
    const deadline = start + Math.min(30_000, Math.max(0, duration));
    if (!Number.isFinite(duration) || performance.now() >= deadline) throw new VoiceCallSessionError("lease-expired");
    return { snapshot, start, deadline };
  }
  private acceptGrant(grant: Grant): void {
    this.assertAlive();
    const old = this.authority;
    if (old && (grant.snapshot.generation < old.snapshot.generation || (grant.snapshot.generation === old.snapshot.generation && grant.start <= old.start))) return;
    this.authority = grant;
    clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(this.resume, Math.max(0, grant.deadline - performance.now()));
    this.emit();
  }
  private bounded<T>(promise: Promise<T>, deadline: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => finish(() => reject(new VoiceCallSessionError("ended")));
      const timer = setTimeout(() => finish(() => reject(new VoiceCallSessionError("context-expired"))), Math.max(0, deadline - performance.now()));
      const finish = (done: () => void) => { clearTimeout(timer); this.lifetime.signal.removeEventListener("abort", abort); done(); };
      this.lifetime.signal.addEventListener("abort", abort, { once: true });
      if (this.lifetime.signal.aborted) abort();
      promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }
  private ownerFence(reason: string): void {
    this.fenceRevision++;
    if (["audience-selection-change", "offered-context-change", "audience-context-change"].includes(reason)) {
      // Invalidate observable agreement synchronously, but preserve the live
      // capability/attempt needed to finish this exact selection/stage/drain.
      if (!this.stopped && this.state !== "retry-required") this.state = "negotiating";
      this.emit(); return;
    }
    if (reason === "generation-transition") { if (!this.stopped) this.state = "waiting"; this.emit(); return; }
    if (!this.stopped) { this.error = "control-failed"; void this.close(reason); }
  }
  private fence(): void { this.fenceRevision++; this.attempt = undefined; clearTimeout(this.contextTimer); this.localConsentPending = false; if (!this.stopped) this.state = "waiting"; this.emit(); }
  private async reconcile(grant: Grant): Promise<void> {
    this.checkCurrent();
    const old = this.authority!.snapshot;
    if (this.transitionFlight) {
      if (grant.snapshot.generation > this.transitionTarget!.generation) throw new VoiceRetirementConflict();
      await this.bounded(this.transitionFlight, grant.start + ATTEMPT_MS); this.acceptGrant(grant); return;
    }
    if (grant.snapshot.generation <= old.generation) { this.acceptGrant(grant); return; }
    if (!this.owner) throw new VoiceCallSessionError("generation-conflict");
    if (this.transitionActive) throw new VoiceRetirementConflict();
    this.fence();
    for (const [id, party] of this.admitted) if (!grant.snapshot.members.some(member => sameVoiceParty(party, voiceControlParty(member)))) this.admitted.delete(id);
    this.sas = [];
    // Set BEFORE calling transition: synchronous Owner work can invoke callbacks.
    this.transitionTarget = grant.snapshot;
    this.transitionActive = true;
    this.acceptGrant(grant);
    try {
      const flight = this.owner.transition(grant.snapshot);
      this.transitionFlight = flight;
      await this.bounded(flight, grant.start + ATTEMPT_MS); this.checkCurrent();
    }
    catch (error) { void this.close("transition-failed"); throw error; }
    finally { this.transitionActive = false; this.transitionFlight = undefined; this.transitionTarget = undefined; this.emit(); }
  }
  private heartbeat(): Promise<Grant> {
    if (this.heartbeatFlight) return this.heartbeatFlight;
    const start = this.issue("priority"), binding = this.binding();
    const flight = this.http.heartbeat(binding, this.secret, this.lifetime.signal).then(snapshot => this.grant(snapshot, start));
    this.heartbeatFlight = flight;
    void flight.finally(() => { if (this.heartbeatFlight === flight) this.heartbeatFlight = undefined; }).catch(() => {});
    return flight;
  }
  private readonly transport: VoiceOwnerTransport = async input => {
    this.checkCurrent();
    let start: number;
    try { start = this.issue("ordinary"); } catch (error) { void this.close("budget-exhausted"); throw error; }
    try {
      const value = await this.http.crypto(input.binding, input.request, this.secret, input.signal);
      this.checkCurrent();
      // Retirement/new-generation traffic MUST complete immediately, or the drain
      // would await its own transition. Only captured OLD binding responses gate.
      if (this.transitionFlight && this.transitionTarget && input.binding.expectedGeneration < this.transitionTarget.generation) await this.bounded(this.transitionFlight, start + ATTEMPT_MS);
      else if (this.discovery && !this.transitionActive) {
        const grant = await this.bounded(this.discovery, start + ATTEMPT_MS);
        if (input.binding.expectedGeneration < grant.snapshot.generation) await this.reconcile(grant);
      }
      this.checkCurrent(); return value;
    } catch (error) {
      if (!(error instanceof VoiceHttpError) || error.code !== "conflict" || error.status !== 409) throw error;
      if (this.transitionActive) { const conflict = new VoiceRetirementConflict(); void this.close(conflict.code); throw conflict; }
      this.fence();
      try {
        if (!this.discovery) {
          const flight = this.heartbeat(); this.discovery = flight;

        }
        const grant = await this.bounded(this.discovery, start + ATTEMPT_MS);
        if (grant.snapshot.generation <= input.binding.expectedGeneration) throw new VoiceCallSessionError("generation-conflict");
        await this.reconcile(grant);
        // Genuine failure, never fabricated native success. Owner observes its revision.
        throw error;
      } catch (failure) {
        if (failure !== error) void this.close(failure instanceof VoiceCallSessionError ? failure.code : "reconciliation-failed");
        throw failure;
      } finally { this.discovery = undefined; }
    }
  };
  private scheduleHeartbeat(): void {
    if (this.stopped) return;
    this.heartbeatTimer = setTimeout(() => { void (async () => {
      try { const grant = await this.heartbeat(); await this.reconcile(grant); }
      catch (error) { this.fail(error); }
      finally { this.scheduleHeartbeat(); }
    })(); }, HEARTBEAT_MS);
  }
  private schedulePoll(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      this.pollFlight = this.poll();
      void this.pollFlight.finally(() => { this.pollFlight = undefined; this.schedulePoll(); }).catch(() => {});
    }, Math.max(POLL_MS, this.lastPollStart + POLL_MS - performance.now()));
  }
  private async poll(): Promise<void> {
    try {
      this.checkCurrent(); this.prune();
      if (this.state === "retry-required" || this.transitionActive || this.actionFlight || this.requests.length + 4 > HTTP_LIMIT - PRIORITY_RESERVE) return;
      const owner = this.owner!; this.lastPollStart = performance.now();
      const start = performance.now(), events = await owner.receiveAgreement();
      this.checkCurrent();
      await this.process(events, start);
      this.sas = await owner.verificationStates(); this.checkCurrent(); this.emit();
    } catch (error) { this.fail(error); }
  }
  private assertAttempt(attempt: Attempt): void {
    this.checkCurrent();
    if (this.attempt !== attempt || attempt.revision !== this.selectionRevision || performance.now() >= attempt.deadline) throw new VoiceCallSessionError("context-expired");
  }
  private newAttempt(start: number): Attempt {
    const attempt = { deadline: start + ATTEMPT_MS, revision: this.selectionRevision, installed: false };
    this.attempt = attempt; this.state = "negotiating"; this.emit();
    clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => { if (this.attempt === attempt && !attempt.installed) this.retryRequired(); }, Math.max(0, attempt.deadline - performance.now()));
    return attempt;
  }
  private retryRequired(): void { this.attempt = undefined; clearTimeout(this.contextTimer); this.state = "retry-required"; this.error = "context-expired"; this.emit(); }
  private control(proposal: VoiceContextProposal, recipient: VoiceControlParty, kind: VoiceContextControl["kind"]): VoiceContextControl {
    const self = this.authority!.snapshot.members.find(member => member.memberId === this.authority!.snapshot.memberId)!;
    return { version: 1, purpose: VOICE_CONTROL_EVENT, kind, callId: proposal.callId, generation: proposal.generation, epochId: proposal.epochId, sequence: proposal.sequence, reference: proposal.reference, audience: [...proposal.audience], leader: proposal.leader, sender: voiceControlParty(self), recipient, transaction: kind === "context-offer" ? proposal.reference : crypto.randomUUID() };
  }
  private async fanout(attempt: Attempt, kind: "context-offer" | "context-accept"): Promise<void> {
    const proposal = attempt.proposal!;
    for (const recipient of proposal.audience) if (recipient.memberId !== this.authority!.snapshot.memberId) {
      this.assertAttempt(attempt);
      const control = this.control(proposal, recipient, kind);
      await this.owner!.sendContextControl(control); this.assertAttempt(attempt);
    }
  }
  private async propose(attempt: Attempt): Promise<void> {
    this.assertAttempt(attempt);
    const offer = await this.owner!.createContextOffer(); this.assertAttempt(attempt);
    attempt.ref = offer.ref; attempt.proposal = offer.proposal;
    await this.owner!.stageOfferedContext(offer.ref); this.assertAttempt(attempt);
    await this.fanout(attempt, "context-offer"); await this.fanout(attempt, "context-accept");
    await this.install(attempt);
  }
  private async install(attempt: Attempt): Promise<void> {
    this.assertAttempt(attempt);
    if (!attempt.ref || attempt.installed || !await this.owner!.contextAgreementComplete(attempt.ref)) return;
    this.assertAttempt(attempt);
    this.transitionActive = true;
    let drained: VoiceOwnerControl[];
    try { drained = await this.owner!.installContext(attempt.ref); } finally { this.transitionActive = false; }
    this.assertAttempt(attempt);
    // This unactivated slice has no media consumer. Unexpected authenticated
    // material ends the call explicitly; it cannot become silent readiness.
    for (const control of drained) this.mediaControl(control);
    attempt.installed = true; clearTimeout(this.contextTimer); this.state = "agreed"; this.emit();
  }
  private mediaControl(_control: VoiceOwnerControl): never { this.checkCurrent(); throw new VoiceCallSessionError("unsupported-media"); }
  private async process(events: VoiceOwnerAgreementReceived[], start: number): Promise<void> {
    let restart = false;
    // Stage every offer before pending material from this same batch. No new receive
    // until every capability below is consumed by the one native Owner.
    for (const event of events) {
      this.checkCurrent();
      if (event.kind === "context-not-ready") { this.localConsentPending = true; if (!this.attempt) this.state = "waiting"; continue; }
      if (event.kind === "context" && event.contextKind === "context-offer") {
        if (!this.attempt) throw new VoiceCallSessionError("not-ready");
        // A genuine next leader offer may replace an installed exact context under
        // the still-current local selection. New roster transitions clear selection.
        const attempt = this.attempt.installed ? this.newAttempt(start) : this.attempt;
        attempt.deadline = Math.min(attempt.deadline, start + ATTEMPT_MS);
        this.assertAttempt(attempt); await this.owner!.stageOfferedContext(event.ref); this.assertAttempt(attempt);
        attempt.ref = event.ref; attempt.proposal = event.proposal;
        await this.fanout(attempt, "context-accept");
      } else if (event.kind === "context") {
        if (event.contextKind === "context-restart") restart = (await this.owner!.acceptContextControl(event.ref)) || restart;
        else { if (this.attempt) this.assertAttempt(this.attempt); await this.owner!.acceptContextControl(event.ref); }
      } else if (event.kind === "pending-material") {
        if (!this.attempt) throw new VoiceCallSessionError("not-ready");
        this.assertAttempt(this.attempt); await this.owner!.retainPendingMaterial(event.ref);
      } else if (event.kind === "media") this.mediaControl(event.control);
    }
    if (this.attempt && !this.attempt.installed) await this.install(this.attempt);
    if (restart && this.attempt?.installed) {
      this.negotiationCapacity(); const next = this.newAttempt(performance.now()); this.state = "negotiating"; await this.propose(next);
    }
    this.emit();
  }
  private async action(operation: () => Promise<void>): Promise<void> {
    this.checkCurrent();
    if (this.actionFlight || this.transitionActive) throw new VoiceCallSessionError("not-ready");
    // Product serialization covers user actions and complete batches only; this is
    // not a native queue. Transition/heartbeat never wait on this action promise.
    const flight = (async () => { await this.pollFlight; this.checkCurrent(); await operation(); this.sas = await this.owner!.verificationStates(); this.checkCurrent(); this.emit(); })();
    this.actionFlight = flight;
    try { await flight; } catch (error) { this.fail(error); throw error; } finally { this.actionFlight = undefined; }
  }
  requestVerification(memberId: string): Promise<void> {
    return this.action(async () => {
      const self = this.authority!.snapshot.memberId;
      if (self >= memberId || !this.authority!.snapshot.members.some(member => member.memberId === memberId)) throw new VoiceCallSessionError("not-ready");
      await this.owner!.requestVerification(memberId);
    });
  }
  verificationStep(handle: string, step: "accept" | "start" | "accept-sas" | "confirm" | "cancel"): Promise<void> { return this.action(() => this.owner!.verificationStep(handle, step)); }
  admit(memberId: string): Promise<void> {
    return this.action(async () => {
      const member = this.authority!.snapshot.members.find(member => member.memberId === memberId);
      if (!member || memberId === this.authority!.snapshot.memberId) throw new VoiceCallSessionError("not-ready");
      await this.owner!.admit(memberId); this.checkCurrent(); this.admitted.set(memberId, voiceControlParty(member));
    });
  }
  confirmFullRoster(): Promise<void> {
    const start = performance.now();
    return this.action(async () => {
      this.checkCurrent(); this.negotiationCapacity();
      const snapshot = this.authority!.snapshot, members = [...snapshot.members].sort((a, b) => a.memberId.localeCompare(b.memberId));
      if (members.some(member => member.memberId !== snapshot.memberId && (!this.admitted.has(member.memberId) || !sameVoiceParty(this.admitted.get(member.memberId)!, voiceControlParty(member))))) throw new VoiceCallSessionError("not-ready");
      this.selectionRevision++; const attempt = this.newAttempt(start); this.assertAttempt(attempt);
      await this.owner!.selectAudience(members.map(member => member.memberId), this.selectionRevision); this.assertAttempt(attempt);
      this.localConsentPending = false; this.error = undefined; this.state = "negotiating";
      if (members[0].memberId === snapshot.memberId) await this.propose(attempt);
    });
  }
  private fail(error: unknown): void {
    if (this.stopped) return;
    if (error instanceof VoiceCallSessionError && error.code === "context-expired") { this.retryRequired(); return; }
    if (error instanceof VoiceCallSessionError && (error.code === "not-ready" || error.code === "budget-exhausted")) { this.error = error.code; this.emit(); return; }
    // Owner itself classifies obsolete completions only after an authoritative
    // transition. Current/unrecognized failures never become synthetic success.
    if (this.isInterrupted(error) && this.authority) { this.fence(); return; }
    this.error = error instanceof VoiceHttpError || error instanceof VoiceCallSessionError ? error.code : "control-failed"; void this.close(this.error);
  }
  close(reason = "left"): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.stopped = true; this.fenceRevision++; this.state = "ended"; this.attempt = undefined;
    this.lifetime.abort();
    clearTimeout(this.pollTimer); clearTimeout(this.heartbeatTimer); clearTimeout(this.contextTimer); clearTimeout(this.leaseTimer);
    if (typeof window !== "undefined") window.removeEventListener?.("pageshow", this.resume);
    globalThis.document?.removeEventListener("visibilitychange", this.resume);
    this.emit();
    const snapshot = this.authority?.snapshot, secret = this.secret; this.secret = "";
    this.cleanup = (async () => {
      try { await this.owner?.close(reason); }
      finally { if (this.guard) await releaseUnusedVoiceOwnerGuard(this.guard); }
      if (snapshot && secret) {
        const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 2_000);
        try { this.issue("priority", true); await this.http.leave(this.binding(snapshot), secret, abort.signal); } catch { /* Lease/reaper remains authoritative. */ } finally { clearTimeout(timer); }
      }
      this.admitted.clear(); this.sas = []; this.emit(); this.listeners.clear();
    })();
    return this.cleanup;
  }
}
