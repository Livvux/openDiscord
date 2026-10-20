import { readExistingDmEnrollment } from "../dm/enrollment";
import { createVoiceHttpClient, VoiceHttpError, voiceHttpSnapshotSchema } from "./http-client";
import { acquireVoiceOwnerGuard, releaseUnusedVoiceOwnerGuard, type VoiceOwnerGuard } from "./owner-guard";
import { sameVoiceParty, validateVoiceOwnerControl, voiceControlParty, VOICE_CONTROL_EVENT, type VoiceControlParty, type VoiceOwnerControl } from "./owner-control";
import type { VoiceBinding, VoiceSnapshot } from "./contracts";
import type { VoiceAgreementEventRef, VoiceOwnerAgreementReceived, VoiceOwnerTransport, VoiceProductOwnerPort, VoiceSasState } from "./crypto-owner";
import { VoiceContextRejected, sameVoiceProposal, type VoiceContextProposal } from "./epoch-agreement";
import type { VoiceContextControl } from "./context-control";
import type { VoiceMediaView, MediaSession, InstalledVoiceMediaContext } from "./media-session";
import { isRetryableVoiceJoinError, retryVoiceRequest, transientVoiceReason, VOICE_JOIN_RETRY_DELAYS_MS, voiceKeyingBudgetMs } from "./retry";

const POLL_MS = 1_000, HEARTBEAT_MS = 10_000, ATTEMPT_MS = 10_000, WINDOW_MS = 60_000;
// All HTTP actions share this budget. Optional work leaves 18 slots for heartbeat,
// conflict resolution and leave; the total 180 still leaves 60 server slots/minute.
const HTTP_LIMIT = 180, PRIORITY_RESERVE = 18;
type Priority = "ordinary" | "priority";
export class VoiceCallSessionError extends Error {
  constructor(readonly code: "browser-unavailable" | "messaging-setup-required" | "ended" | "lease-expired" | "context-expired" | "budget-exhausted" | "not-ready" | "binding-changed" | "generation-conflict" | "retirement-conflict" | "unsupported-media" | "call-full" | "server-unreachable" | "previous-call-closing" | "rate-limited") { super(`Voice call ${code}.`); this.name = "VoiceCallSessionError"; }
}

/** Join failures as session codes, so the UI never imports the HTTP client. */
export function joinFailure(error: unknown): unknown {
  if (!(error instanceof VoiceHttpError)) return error;
  if (error.code === "call_full") return new VoiceCallSessionError("call-full");
  if (error.code === "network" || error.code === "timeout" || (error.status ?? 0) >= 500) return new VoiceCallSessionError("server-unreachable");
  if (error.code === "conflict") return new VoiceCallSessionError("previous-call-closing");
  if (error.code === "rate_limited") return new VoiceCallSessionError("rate-limited");
  return error;
}
export class VoiceRetirementConflict extends VoiceCallSessionError { constructor() { super("retirement-conflict"); this.name = "VoiceRetirementConflict"; } }
export type VoiceCallState = "verifying" | "waiting" | "negotiating" | "agreed" | "retry-required" | "ended";
type VoiceSasView = Readonly<Omit<VoiceSasState, "emojiIndices" | "emoji"> & { emojiIndices: readonly number[] | null; emoji?: readonly Readonly<{ symbol: string; description: string }>[] | null }>;
export type VoiceCallView = Readonly<{
  state: VoiceCallState; roster: readonly Readonly<VoiceSnapshot["members"][number]>[];
  keysPrepared: boolean; fenceRevision: number; generation: number; selfMemberId: string; admittedMemberIds: readonly string[]; sas: readonly VoiceSasView[];
  localConsentPending: boolean; media: VoiceMediaView; error?: string;
  /** A transient control request failure is being retried within the current lease. */
  reconnecting: boolean;
}>;
export type VoiceCallOptions = {
  /** Exactly one call context: a community voice channel or a direct-message conversation. */
  accountId: string; sessionId: string; channelId?: string; conversationId?: string; consent: true;
  /** Must throw after account/session replacement or provider destruction. */
  assertSessionCurrent(): void;
  fetch?: typeof fetch;
};
type Attempt = { deadline: number; revision: number; ref?: VoiceAgreementEventRef; proposal?: VoiceContextProposal; installed: boolean };
type Grant = { snapshot: VoiceSnapshot; start: number; deadline: number };

/** Authenticated browser call lifetime. DM enrollment is an explicit prerequisite. */
export class CallSession {
  private readonly lifetime = new AbortController();
  private readonly http;
  private readonly listeners = new Set<() => void>();
  private readonly requests: number[] = [];
  private readonly admitted = new Map<string, VoiceControlParty>();
  private owner?: VoiceProductOwnerPort;
  private media?: MediaSession;
  private mediaView: VoiceMediaView = Object.freeze({ mediaState: "none", sources: [], microphone: false, camera: false, screenShare: false, audioBlocked: false, tiles: [] });
  private readonly audioRoots = new Map<HTMLElement, (() => void) | undefined>();
  private isInterrupted: (error: unknown) => boolean = () => false;
  private guard?: VoiceOwnerGuard;
  private secret = "";
  private authority?: Grant;
  private state: VoiceCallState = "verifying";
  private error?: string;
  private sas: VoiceSasState[] = [];
  private localConsentPending = false;
  private preparedKeysGeneration?: number;
  private keyPreparation?: { generation: number; promise: Promise<boolean> };
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
  private retrying = 0;
  // Retries exhausted on a network/5xx failure; the Owner then stops and names it in its fence.
  private transportFailure?: string;
  private readonly onRetry = (active: boolean) => { this.retrying += active ? 1 : -1; if (!this.stopped) this.emit(); };
  private actionFlight?: Promise<void>;
  private view: VoiceCallView = Object.freeze({ state: "verifying", roster: [], keysPrepared: false, fenceRevision: 0, generation: 0, selfMemberId: "", admittedMemberIds: [], sas: [], localConsentPending: false, media: this.mediaView, reconnecting: false });
  private readonly resume = () => { try { this.checkCurrent(); } catch { /* checkCurrent closes synchronously */ } };
  private constructor(private readonly options: VoiceCallOptions) { this.http = createVoiceHttpClient({ fetch: options.fetch }); }

  static async create(options: VoiceCallOptions): Promise<CallSession> {
    if (typeof window === "undefined") throw new VoiceCallSessionError("browser-unavailable");
    options.assertSessionCurrent();
    if (options.consent !== true || !options.accountId || !options.sessionId || !options.channelId === !options.conversationId) throw new VoiceCallSessionError("not-ready");
    let anchor = readExistingDmEnrollment(options.accountId);
    if (!anchor) throw new VoiceCallSessionError("messaging-setup-required");
    const session = new CallSession(options);
    try {
      session.guard = await acquireVoiceOwnerGuard(options.accountId);
      session.assertAlive();
      session.secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
      const input = { ...(options.conversationId ? { conversationId: options.conversationId } : { channelId: options.channelId }), joinNonce: crypto.randomUUID(), voiceDeviceId: crypto.randomUUID(), enrollmentSecret: session.secret, consent: true as const };
      let start = 0;
      const snapshot = await retryVoiceRequest(() => { start = session.issue("priority"); return session.http.join(input, anchor!, session.lifetime.signal); }, session.lifetime.signal, undefined, VOICE_JOIN_RETRY_DELAYS_MS, isRetryableVoiceJoinError);
      anchor = null;
      session.acceptGrant(session.grant(snapshot, start));
      // WASM/native module evaluation happens only after explicit browser join consent.
      const { createVoiceProductOwner, VoiceGenerationInterrupted } = await import("./crypto-owner");
      session.isInterrupted = error => error instanceof VoiceGenerationInterrupted;
      session.checkCurrent();
      session.owner = await createVoiceProductOwner({ accountId: options.accountId, guard: session.guard, snapshot, lifetime: { signal: session.lifetime.signal, assertCurrent: () => session.checkCurrent() }, transport: session.transport, onFence: reason => session.ownerFence(reason) });
      session.checkCurrent();
      await session.prepareKeys();
      window.addEventListener?.("pageshow", session.resume);
      globalThis.document?.addEventListener("visibilitychange", session.resume);
      session.emit(); session.schedulePoll(); session.scheduleHeartbeat();
      return session;
    } catch (error) {
      anchor = null; await session.close("bootstrap-failed");
      throw joinFailure(error);
    }
  }
  getSnapshot = (): VoiceCallView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private emit(): void {
    const snapshot = this.authority?.snapshot;
    this.view = Object.freeze({ state: this.state, media: this.mediaView, keysPrepared: !!snapshot && this.preparedKeysGeneration === snapshot.generation, fenceRevision: this.fenceRevision, roster: Object.freeze((snapshot?.members ?? []).map(member => Object.freeze({ ...member }))), generation: snapshot?.generation ?? 0, selfMemberId: snapshot?.memberId ?? "", admittedMemberIds: Object.freeze([...this.admitted.keys()].sort()), sas: Object.freeze(this.sas.map(value => Object.freeze({ ...value, peer: Object.freeze({ ...value.peer }), ...(value.emoji ? { emoji: Object.freeze(value.emoji.map(emoji => Object.freeze({ ...emoji }))) } : {}), emojiIndices: value.emojiIndices ? Object.freeze([...value.emojiIndices]) : null }))), localConsentPending: this.localConsentPending, reconnecting: !this.stopped && this.retrying > 0, ...(this.error ? { error: this.error } : {}) });
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
    if (snapshot.channelId !== this.options.channelId || snapshot.conversationId !== this.options.conversationId || own?.userId !== this.options.accountId) throw new VoiceCallSessionError("binding-changed");
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
    this.media?.fence(); this.media = undefined;
    this.fenceRevision++;
    if (["audience-selection-change", "offered-context-change", "audience-context-change"].includes(reason)) {
      // Invalidate observable agreement synchronously, but preserve the live
      // capability/attempt needed to finish this exact selection/stage/drain.
      if (!this.stopped && this.state !== "retry-required") this.state = "negotiating";
      this.emit(); return;
    }
    if (reason === "generation-transition") { if (!this.stopped) this.state = "waiting"; this.emit(); return; }
    if (!this.stopped) { this.error = this.transportFailure ?? "control-failed"; void this.close(reason); }
  }
  private fence(): void { this.media?.fence(); this.media = undefined; this.fenceRevision++; this.attempt = undefined; clearTimeout(this.contextTimer); this.localConsentPending = false; if (!this.stopped) this.state = "waiting"; this.emit(); }
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
    this.preparedKeysGeneration = undefined;
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
    const binding = this.binding(); let start = 0;
    // Lease renewal is idempotent. Each retry re-checks the lease and charges the budget; the
    // grant uses that retry's own start, so a late success never extends authority.
    const flight = retryVoiceRequest(() => { start = this.issue("priority"); return this.http.heartbeat(binding, this.secret, this.lifetime.signal); }, this.lifetime.signal, this.onRetry).then(snapshot => this.grant(snapshot, start));
    this.heartbeatFlight = flight;
    void flight.finally(() => { if (this.heartbeatFlight === flight) this.heartbeatFlight = undefined; }).catch(() => {});
    return flight;
  }
  private readonly transport: VoiceOwnerTransport = async input => {
    this.checkCurrent();
    let start = 0;
    const issue = () => {
      this.checkCurrent();
      try { start = this.issue("ordinary"); } catch (error) { void this.close("budget-exhausted"); throw error; }
    };
    try {
      // Identical body and request ID: the server replays its receipt (sync/ACK/query are
      // naturally idempotent). Every attempt re-checks lease/fence and charges the budget.
      const value = await retryVoiceRequest(() => { issue(); return this.http.crypto(input.binding, input.request, this.secret, input.signal); }, input.signal, this.onRetry);
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
      this.transportFailure = transientVoiceReason(error) ?? this.transportFailure;
      return this.conflict(error, input.binding, start);
    }
  };
  private async conflict(error: unknown, binding: VoiceBinding, start: number): Promise<never> {
    if (!(error instanceof VoiceHttpError) || error.code !== "conflict" || error.status !== 409) throw error;
    if (this.transitionActive) { const conflict = new VoiceRetirementConflict(); void this.close(conflict.code); throw conflict; }
    this.fence();
    try {
      this.discovery ??= this.heartbeat();
      const grant = await this.bounded(this.discovery, start + ATTEMPT_MS);
      if (grant.snapshot.generation <= binding.expectedGeneration) throw new VoiceCallSessionError("generation-conflict");
      await this.reconcile(grant);
      // Original failure remains a failure; neither native nor media receives a fake response.
      throw error;
    } catch (failure) {
      if (failure !== error) void this.close(failure instanceof VoiceCallSessionError ? failure.code : "reconciliation-failed");
      throw failure;
    } finally { this.discovery = undefined; }
  }
  private async prepareKeys(): Promise<boolean> {
    this.checkCurrent();
    const snapshot = this.authority!.snapshot;
    if (this.transitionActive) return false;
    if (this.preparedKeysGeneration === snapshot.generation) return true;
    // Own successful factory bootstrap already published own device keys. Remote
    // publication is authority metadata only: active never implies trust/consent.
    if (snapshot.members.some(member => member.memberId !== snapshot.memberId && member.state !== "active")) return false;
    if (this.keyPreparation) {
      if (this.keyPreparation.generation !== snapshot.generation) return false;
      return this.keyPreparation.promise;
    }
    this.prune();
    if (this.requests.length >= HTTP_LIMIT - PRIORITY_RESERVE) return false;
    const start = performance.now();
    const promise = (async () => {
      try { await this.bounded(this.owner!.query(snapshot.members.map(member => member.memberId)), start + ATTEMPT_MS); }
      catch (error) { if (!this.isInterrupted(error)) void this.close("key-preparation-failed"); throw error; }
      this.checkCurrent();
      const current = this.authority!.snapshot;
      if (this.transitionActive || current.generation !== snapshot.generation || current.callId !== snapshot.callId || current.memberId !== snapshot.memberId || current.joinNonce !== snapshot.joinNonce || current.voiceDeviceId !== snapshot.voiceDeviceId || current.voiceUserId !== snapshot.voiceUserId) return false;
      this.preparedKeysGeneration = current.generation; this.emit(); return true;
    })();
    const flight = { generation: snapshot.generation, promise }; this.keyPreparation = flight;
    try { return await promise; }
    finally { if (this.keyPreparation === flight) this.keyPreparation = undefined; }
  }
  private scheduleHeartbeat(): void {
    if (this.stopped) return;
    this.heartbeatTimer = setTimeout(() => { void (async () => {
      try { const grant = await this.heartbeat(); await this.reconcile(grant); await this.prepareKeys(); }
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
      if (!await this.prepareKeys() || this.transitionActive || this.preparedKeysGeneration !== this.authority!.snapshot.generation) return;
      this.checkCurrent();
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
    this.commitAttempt(attempt);
    return attempt;
  }
  private commitAttempt(attempt: Attempt): void {
    this.attempt = attempt; this.state = "negotiating"; this.emit();
    clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => { if (this.attempt === attempt && !attempt.installed) this.retryRequired(); }, Math.max(0, attempt.deadline - performance.now()));
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
    try {
      const drained = await this.owner!.installContext(attempt.ref);
      this.assertAttempt(attempt);
      const installedAt = performance.now(), revision = this.fenceRevision;
      // Fixed from installation and never reset; the live call lease still ends the call
      // (and fences media) independently through checkCurrent/leaseTimer.
      const deadline = installedAt + voiceKeyingBudgetMs(attempt.proposal!.audience.length - 1);
      attempt.installed = true; clearTimeout(this.contextTimer);
      const current = () => {
        this.checkCurrent();
        if (this.attempt !== attempt || !attempt.installed || this.fenceRevision !== revision) throw new VoiceCallSessionError("binding-changed");
      };
      const snapshot = structuredClone(this.authority!.snapshot), proposal = attempt.proposal!;
      snapshot.members.forEach(Object.freeze); snapshot.removals.forEach(Object.freeze);
      Object.freeze(snapshot.members); Object.freeze(snapshot.removals); Object.freeze(snapshot);
      const context: InstalledVoiceMediaContext = Object.freeze({ snapshot, epochId: proposal.epochId, proposalSequence: proposal.sequence, reference: proposal.reference, audience: Object.freeze(proposal.audience.map(party => Object.freeze({ ...party }))), self: Object.freeze(voiceControlParty(snapshot.members.find(member => member.memberId === snapshot.memberId)!)), deadline });
      // Type-only import above keeps SSR free of Worker/LiveKit evaluation.
      const { MediaSession } = await this.bounded(import("./media-session"), deadline); current();
      const media = new MediaSession(context, {
        current,
        presentation: view => { this.mediaView = view; this.emit(); },
        send: async control => {
          current(); validateVoiceOwnerControl(control, snapshot, context.epochId, context.audience, context.proposalSequence);
          if (!sameVoiceParty(control.sender, context.self)) throw new VoiceCallSessionError("binding-changed");
          await this.owner!.sendControl(control); current();
        },
        token: async () => {
          current(); const binding = this.binding(), start = this.issue("ordinary");
          try {
            const grant = await this.http.token(binding, this.secret, this.lifetime.signal); current();
            const lease = this.grant(grant.snapshot, start); this.acceptGrant(lease); current();
            const tokenDeadline = Math.min(this.authority!.deadline, lease.deadline, start + Math.max(0, Date.parse(grant.expiresAt) - Date.parse(grant.snapshot.serverTime)));
            if (performance.now() >= tokenDeadline) throw new VoiceCallSessionError("lease-expired");
            return { grant, deadline: tokenDeadline };
          } catch (error) { return this.conflict(error, binding, start); }
        },
        fatal: reason => { void this.close(reason); },
      });
      current(); this.media = media; for (const container of this.audioRoots.keys()) this.audioRoots.set(container, media.mountAudio(container)); media.start();
      // Only the installed Owner returns these authenticated controls, exactly once.
      for (const control of drained) { current(); await media.consume(control); current(); }
      this.state = "agreed"; this.emit();
    } catch (error) { void this.close("media-initialization-failed"); throw error; }
    finally { this.transitionActive = false; }
  }
  private async mediaControl(control: VoiceOwnerControl): Promise<void> {
    this.checkCurrent(); const media = this.media;
    if (!media) throw new VoiceCallSessionError("unsupported-media");
    await media.consume(control); this.checkCurrent();
    if (this.media !== media) throw new VoiceCallSessionError("binding-changed");
  }
  private async process(events: VoiceOwnerAgreementReceived[], start: number): Promise<void> {
    let restart = false;
    let rejectedProposal: VoiceContextProposal | undefined;
    // Stage every offer before pending material from this same batch. No new receive
    // until every capability below is consumed by the one native Owner.
    for (const event of events) {
      this.checkCurrent();
      // The Owner validated this whole batch first. Only this rejected proposal
      // group loses its transient refs; installed-current media still fails below.
      if (rejectedProposal && ((event.kind === "context" && sameVoiceProposal(event.proposal, rejectedProposal)) || event.kind === "pending-material")) continue;
      if (event.kind === "context-not-ready") { this.localConsentPending = true; if (!this.attempt) this.state = "waiting"; continue; }
      if (event.kind === "context" && event.contextKind === "context-offer") {
        if (!this.attempt) throw new VoiceCallSessionError("not-ready");
        // A prospective replacement has no observable state/timer/ref effects.
        // The real Owner can reject a genuine lower/retired replay nonfatally.
        const previous = this.attempt;
        const attempt: Attempt = { deadline: previous.installed ? start + ATTEMPT_MS : Math.min(previous.deadline, start + ATTEMPT_MS), revision: this.selectionRevision, installed: false, ref: event.ref, proposal: event.proposal };
        const assertProspective = () => {
          this.checkCurrent();
          if (this.attempt !== previous || attempt.revision !== this.selectionRevision || performance.now() >= attempt.deadline) throw new VoiceCallSessionError("context-expired");
        };
        assertProspective();
        try { await this.owner!.stageOfferedContext(event.ref); }
        catch (error) {
          if (!(error instanceof VoiceContextRejected)) throw error;
          rejectedProposal = event.proposal; continue;
        }
        // A valid Owner stage already fenced synchronously through onFence.
        assertProspective(); this.commitAttempt(attempt);
        await this.fanout(attempt, "context-accept");
      } else if (event.kind === "context") {
        if (event.contextKind === "context-restart") restart = (await this.owner!.acceptContextControl(event.ref)) || restart;
        else { if (this.attempt) this.assertAttempt(this.attempt); await this.owner!.acceptContextControl(event.ref); }
      } else if (event.kind === "pending-material") {
        if (!this.attempt) throw new VoiceCallSessionError("not-ready");
        this.assertAttempt(this.attempt); await this.owner!.retainPendingMaterial(event.ref);
      } else if (event.kind === "media") await this.mediaControl(event.control);
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
    const flight = (async () => { await this.pollFlight; this.checkCurrent(); if (!await this.prepareKeys() || this.transitionActive || this.preparedKeysGeneration !== this.authority!.snapshot.generation) throw new VoiceCallSessionError("not-ready"); this.checkCurrent(); await operation(); this.sas = await this.owner!.verificationStates(); this.checkCurrent(); this.emit(); })();
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
  mountAudio(container: HTMLElement): () => void {
    this.checkCurrent(); this.audioRoots.set(container, this.media?.mountAudio(container));
    return () => { this.audioRoots.get(container)?.(); this.audioRoots.delete(container); };
  }
  mountVideo(id: string, element: HTMLVideoElement): () => void { this.checkCurrent(); if (!this.media) throw new VoiceCallSessionError("not-ready"); return this.media.mountVideo(id, element); }
  startAudio(): Promise<void> { this.checkCurrent(); if (!this.media) return Promise.reject(new VoiceCallSessionError("not-ready")); return this.media.startAudio(); }
  setMicrophoneEnabled(enabled: boolean): Promise<void> { this.checkCurrent(); if (!this.media) return Promise.reject(new VoiceCallSessionError("not-ready")); return this.media.setSource("microphone", enabled); }
  setCameraEnabled(enabled: boolean): Promise<void> { this.checkCurrent(); if (!this.media) return Promise.reject(new VoiceCallSessionError("not-ready")); return this.media.setSource("camera", enabled); }
  setScreenShareEnabled(enabled: boolean): Promise<void> { this.checkCurrent(); if (!this.media) return Promise.reject(new VoiceCallSessionError("not-ready")); return this.media.setSource("screen_share", enabled); }
  private fail(error: unknown): void {
    if (this.stopped) return;
    if (error instanceof VoiceCallSessionError && error.code === "context-expired") { this.retryRequired(); return; }
    if (error instanceof VoiceCallSessionError && (error.code === "not-ready" || error.code === "budget-exhausted")) { this.error = error.code; this.emit(); return; }
    // Owner itself classifies obsolete completions only after an authoritative
    // transition. Current/unrecognized failures never become synthetic success.
    if (this.isInterrupted(error) && this.authority) { this.fence(); return; }
    this.error = transientVoiceReason(error) ?? (error instanceof VoiceHttpError || error instanceof VoiceCallSessionError ? error.code : "control-failed"); void this.close(this.error);
  }
  close(reason = "left"): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.media?.fence(); this.media = undefined;
    this.audioRoots.forEach(detach => detach?.()); this.audioRoots.clear();
    this.error ??= reason === "left" ? undefined : reason;
    this.stopped = true; this.preparedKeysGeneration = undefined; this.fenceRevision++; this.state = "ended"; this.attempt = undefined;
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
