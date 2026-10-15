import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { z } from "zod";
import { VOICE_DOMAIN, VOICE_LIMITS, voiceBindingSchema, voiceCryptoSchema, voiceEventSchema, type VoiceBinding, type VoiceCryptoRequest, type VoiceMember, type VoiceSnapshot } from "./contracts";
import { consumeVoiceOwnerGuard, type VoiceOwnerGuard } from "./owner-guard";
import { sameVoiceParty, validateVoiceOwnerControl, voiceControlParty, VOICE_CONTROL_EVENT, type VoiceControlParty, type VoiceOwnerControl } from "./owner-control";

type NativeRequest = Awaited<ReturnType<C.OlmMachine["outgoingRequests"]>>[number];
type Entry = { readonly id: string; readonly type: C.RequestType; readonly body: string; readonly digest: string; readonly firstObservedGeneration: number; readonly request: NativeRequest; state: "pending" | "in-flight" | "completing" | "completed"; attempts: Map<string, { input: VoiceCryptoRequest; binding: VoiceBinding; promise?: Promise<void> }> };
type Flow = { handle: string; peer: VoiceControlParty; generation: number; request: C.VerificationRequest; sas?: C.Sas; confirmed: boolean };
export type VoiceSasState = { handle: string; peer: VoiceControlParty; flowId: string; ready: boolean; done: boolean; cancelled: boolean; confirmed: boolean; emojiIndices: number[] | null };
export type VoiceOwnerTransport = (input: Readonly<{ binding: VoiceBinding; request: VoiceCryptoRequest; signal: AbortSignal }>) => Promise<unknown>;
export class VoiceGenerationInterrupted extends Error { constructor() { super("Voice generation interrupted."); } }
export type VoiceOwnerOptions = { accountId: string; guard: VoiceOwnerGuard; snapshot: VoiceSnapshot; lifetime: { assertCurrent(): void; signal: AbortSignal }; transport: VoiceOwnerTransport; onFence(reason: string): void };
const syncSchema = z.object({ cursor: z.string().regex(/^\d{1,15}$/), events: z.array(z.unknown()).max(VOICE_LIMITS.syncBatch), oneTimeKeys: z.record(z.string(), z.number().int().nonnegative()), unusedFallbackKeys: z.array(z.string()).max(1) }).strict();
const envelopeSchema = z.object({ sender: z.string(), type: z.string(), content: z.record(z.string(), z.unknown()) }).passthrough();
const decryptedSchema = envelopeSchema.extend({ recipient: z.string(), recipient_keys: z.object({ ed25519: z.string() }), sender_device_keys: z.object({ user_id: z.string(), device_id: z.string(), keys: z.record(z.string(), z.string()) }), keys: z.object({ ed25519: z.string() }) });
const deviceOutcomeSchema = z.object({ nativeResponse: z.object({}).strict(), disposition: z.discriminatedUnion("status", [z.object({ status: z.literal("processed-current"), enqueued: z.literal(1) }).strict(), z.object({ status: z.literal("processed-retired"), enqueued: z.literal(0) }).strict()]) }).strict();
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function validateSnapshot(snapshot: VoiceSnapshot): void {
  voiceBindingSchema.parse({ callId: snapshot.callId, memberId: snapshot.memberId, joinNonce: snapshot.joinNonce, expectedGeneration: snapshot.generation });
  z.array(z.unknown()).min(1).max(VOICE_LIMITS.members).parse(snapshot.members);
  if (new Set(snapshot.members.map(member => member.memberId)).size !== snapshot.members.length || new Set(snapshot.members.map(member => member.voiceDeviceId)).size !== snapshot.members.length) throw new Error("Duplicate voice enrollment binding.");
  for (const member of snapshot.members) {
    z.uuid().parse(member.memberId); z.uuid().parse(member.voiceDeviceId); z.uuid().parse(member.joinNonce);
    if (member.voiceUserId !== `@voice_${snapshot.callId}_${member.memberId}:${VOICE_DOMAIN}` || member.participantIdentity !== `v1:${member.memberId}`) throw new Error("Invalid voice-only namespace binding.");
  }
}

/** Unreachable preparation: no route, browser singleton, DM owner, polling or media activation. */
export class VoiceCryptoOwner {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly registry = new Map<string, Entry>();
  private readonly flows = new Map<string, Flow>();
  private readonly admitted = new Set<string>();
  private readonly completedPeers = new Set<string>();
  private readonly abort = new AbortController();
  private stopped = false;
  private transitioning = false;
  private revision = 0;
  private epochId: string | undefined;
  private audience: VoiceControlParty[] = [];
  private cleanup?: Promise<void>;
  private readonly lifetimeLost = () => { this.stop("lifetime-lost"); };
  private constructor(private readonly options: VoiceOwnerOptions, private snapshot: VoiceSnapshot, private readonly machine: C.OlmMachine, private readonly release: () => Promise<void>) {}

  static async create(options: VoiceOwnerOptions): Promise<VoiceCryptoOwner> {
    const release = consumeVoiceOwnerGuard(options.guard, options.accountId);
    let machine: C.OlmMachine | undefined;
    let owner: VoiceCryptoOwner | undefined;
    try {
      options.lifetime.assertCurrent();
      if (options.lifetime.signal.aborted) throw new Error("Voice lifetime already ended.");
      const snapshot = structuredClone(options.snapshot);
      validateSnapshot(snapshot);
      const self = snapshot.members.find(member => member.memberId === snapshot.memberId);
      if (!self || self.userId !== options.accountId || self.voiceUserId !== snapshot.voiceUserId || self.voiceDeviceId !== snapshot.voiceDeviceId || self.joinNonce !== snapshot.joinNonce) throw new Error("Invalid voice owner enrollment.");
      await C.initAsync();
      options.lifetime.assertCurrent();
      machine = await C.OlmMachine.initialize(new C.UserId(snapshot.voiceUserId), new C.DeviceId(snapshot.voiceDeviceId), undefined, undefined, silent);
      machine.roomKeyRequestsEnabled = false;
      machine.roomKeyForwardingEnabled = false;
      owner = new VoiceCryptoOwner(options, snapshot, machine, release);
      options.lifetime.signal.addEventListener("abort", owner.lifetimeLost, { once: true });
      if (options.lifetime.signal.aborted) owner.lifetimeLost();
      await owner.flush();
      const bootstrap = await owner.serial(() => machine!.bootstrapCrossSigning(false));
      if (bootstrap.uploadKeysRequest) await owner.output(bootstrap.uploadKeysRequest);
      await owner.exchange({ kind: "signing", body: JSON.parse(bootstrap.uploadSigningKeysRequest.body) });
      await owner.output(bootstrap.uploadSignaturesRequest);
      await owner.query([snapshot.memberId]);
      return owner;
    } catch (error) {
      if (owner) await owner.close("bootstrap-failed");
      else { try { machine?.close(); } finally { await release(); options.onFence("bootstrap-failed"); } }
      throw error;
    }
  }
  private assertCurrent(allowTransition = false): void {
    if (this.stopped) throw new Error("Voice owner closed.");
    try { this.options.lifetime.assertCurrent(); } catch (error) { this.stop("lifetime-lost"); throw error; }
    if (this.transitioning && !allowTransition) throw new VoiceGenerationInterrupted();
  }
  private serial<T>(work: () => T | Promise<T>, allowTransition = false): Promise<T> {
    const job = this.tail.then(async () => {
      this.assertCurrent(allowTransition);
      const revision = this.revision;
      try {
        const result = await work();
        if (!allowTransition && revision !== this.revision) throw new VoiceGenerationInterrupted();
        this.assertCurrent(allowTransition);
        return result;
      }
      catch (error) { if (!(error instanceof VoiceGenerationInterrupted)) this.stop("native-or-schema-failure"); throw error; }
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
  private stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true; this.revision++; this.abort.abort(); this.admitted.clear(); this.audience = []; this.epochId = undefined;
    try { this.options.onFence(reason); } finally { void this.cleanupNative(); }
  }
  private cleanupNative(): Promise<void> {
    return this.cleanup ??= this.tail.catch(() => undefined).then(async () => { try { this.options.lifetime.signal.removeEventListener("abort", this.lifetimeLost); this.flows.clear(); this.registry.clear(); this.completedPeers.clear(); this.machine.close(); } finally { await this.release(); } });
  }
  close(reason = "closed"): Promise<void> { this.stop(reason); return this.cleanupNative(); }
  private binding(): VoiceBinding { return { callId: this.snapshot.callId, memberId: this.snapshot.memberId, joinNonce: this.snapshot.joinNonce, expectedGeneration: this.snapshot.generation }; }
  private peer(memberId: string): VoiceMember {
    const peer = this.snapshot.members.find(member => member.memberId === memberId);
    if (!peer) throw new Error("Unknown current voice member.");
    return peer;
  }
  private async device(party: VoiceControlParty): Promise<C.Device> {
    const device = await this.machine.getDevice(new C.UserId(party.voiceUserId), new C.DeviceId(party.voiceDeviceId));
    if (!device) throw new Error("Missing current native voice device.");
    return device;
  }
  private async exchange(request: VoiceCryptoRequest, allowTransition = false): Promise<unknown> {
    this.assertCurrent(allowTransition);
    const revision = this.revision;
    const result = await this.options.transport({ binding: this.binding(), request: voiceCryptoSchema.parse(request), signal: this.abort.signal });
    this.assertCurrent(allowTransition);
    if (revision !== this.revision) throw new VoiceGenerationInterrupted();
    return result;
  }
  private async observe(request: NativeRequest, allowTransition = false): Promise<Entry | undefined> {
    if (!(request instanceof C.KeysUploadRequest || request instanceof C.KeysQueryRequest || request instanceof C.KeysClaimRequest || request instanceof C.SignatureUploadRequest || request instanceof C.ToDeviceRequest)) throw new Error("Unsupported native voice output.");
    if (new TextEncoder().encode(request.body).length > VOICE_LIMITS.bootstrapBytes) throw new Error("Native request size exceeded.");
    const body = JSON.parse(request.body) as unknown;
    if (!request.id) {
      if (!(request instanceof C.KeysUploadRequest || request instanceof C.SignatureUploadRequest)) throw new Error("Unexpected untracked native output.");
      return undefined; // Public bootstrap requests without IDs have no markRequestAsSent contract.
    }
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.body))), byte => byte.toString(16).padStart(2, "0")).join("");
    const previous = this.registry.get(request.id);
    if (previous) { if (previous.type !== request.type || previous.body !== request.body || previous.digest !== digest || (previous.request instanceof C.ToDeviceRequest && (!(request instanceof C.ToDeviceRequest) || previous.request.event_type !== request.event_type || previous.request.txn_id !== request.txn_id))) throw new Error("Native request identity mutated."); return previous; }
    if (this.registry.size >= VOICE_LIMITS.receipts) throw new Error("Voice native registry limit.");
    if (allowTransition && request instanceof C.ToDeviceRequest) {
      const parsed = z.object({ messages: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))) }).strict().parse(body);
      const targets = Object.entries(parsed.messages);
      const devices = targets.length === 1 ? Object.entries(targets[0][1]) : [];
      const transaction = devices.length === 1 ? devices[0][1].transaction_id : undefined;
      if (request.event_type !== "m.key.verification.cancel" || ![...this.flows.values()].some(flow => flow.peer.voiceUserId === targets[0]?.[0] && flow.peer.voiceDeviceId === devices[0]?.[0] && flow.request.flowId === transaction)) throw new Error("Unclassifiable first-observed transition output.");
    }
    const entry: Entry = { id: request.id, type: request.type, body: request.body, digest, firstObservedGeneration: this.snapshot.generation, request, state: "pending", attempts: new Map() };
    this.registry.set(entry.id, entry);
    return entry;
  }
  private scopedUser(user: string): boolean {
    const prefix = `@voice_${this.snapshot.callId}_`, suffix = `:${VOICE_DOMAIN}`;
    if (!user.startsWith(prefix) || !user.endsWith(suffix)) return false;
    return z.uuid().safeParse(user.slice(prefix.length, -suffix.length)).success;
  }
  private requestInput(request: NativeRequest, id: string | undefined, retire: boolean): VoiceCryptoRequest {
    const body: unknown = JSON.parse(request.body);
    const requestId = crypto.randomUUID();
    if (request instanceof C.ToDeviceRequest) {
      if (!id) throw new Error("Missing native to-device ID.");
      const input = voiceCryptoSchema.parse({ kind: retire ? "retire" : "send", body, eventType: request.event_type, requestId, nativeRequestId: id, nativeTxnId: request.txn_id });
      const messages = z.object({ messages: z.record(z.string(), z.record(z.string(), z.unknown())) }).strict().parse(body).messages;
      const users = Object.entries(messages), devices = users.length === 1 ? Object.entries(users[0][1]) : [];
      if (users.length !== 1 || !this.scopedUser(users[0][0]) || devices.length !== 1 || !z.uuid().safeParse(devices[0][0]).success || !voiceEventSchema(request.event_type)?.safeParse(devices[0][1]).success) throw new Error("Unsupported native recipient/event shape.");
      return input;
    }
    const kind = request instanceof C.KeysUploadRequest ? "upload" : request instanceof C.KeysQueryRequest ? "query" : request instanceof C.KeysClaimRequest ? "claim" : request instanceof C.SignatureUploadRequest ? "signatures" : undefined;
    if (!kind || retire) throw new Error("Native output cannot retire.");
    if (kind === "signatures" && (typeof body !== "object" || body === null || Object.keys(body).length !== 1 || !this.scopedUser(Object.keys(body)[0]))) throw new Error("Native signatures must have one outer user.");
    if (kind === "query" || kind === "claim") {
      const targets = z.record(z.string(), z.unknown()).parse(z.record(z.string(), z.unknown()).parse(body)[kind === "query" ? "device_keys" : "one_time_keys"]);
      if (Object.keys(targets).length > VOICE_LIMITS.members || Object.keys(targets).some(user => !this.scopedUser(user))) throw new Error("Native query/claim crossed voice call scope.");
    }
    return voiceCryptoSchema.parse({ kind, body, ...(id ? { requestId, nativeRequestId: id } : {}) });
  }
  private async output(request: NativeRequest, retire = false, allowTransition = false): Promise<void> {
    const prepared = await this.serial(async () => {
      const entry = await this.observe(request, allowTransition);
      if (entry?.state === "completed") return undefined;
      const key = `${this.snapshot.generation}:${retire ? "retire" : "send"}`;
      const attempt = entry?.attempts.get(key) ?? { input: this.requestInput(request, entry?.id, retire), binding: this.binding() };
      if (entry) { entry.attempts.set(key, attempt); entry.state = "in-flight"; }
      return { entry, attempt };
    }, allowTransition);
    if (!prepared) return;
    if (prepared.attempt.promise) return prepared.attempt.promise;
    const run = async () => {
      this.assertCurrent(allowTransition);
      const result = await this.options.transport({ binding: prepared.attempt.binding, request: prepared.attempt.input, signal: this.abort.signal });
      await this.serial(async () => {
        const { entry } = prepared;
        if (entry?.state === "completed" || entry?.state === "completing") return;
        let nativeResponse = result;
        if (request instanceof C.ToDeviceRequest) {
          const outcome = deviceOutcomeSchema.parse(result);
          if ((retire ? "processed-retired" : "processed-current") !== outcome.disposition.status) throw new Error("Native transport disposition mismatch.");
          nativeResponse = outcome.nativeResponse;
        }
        if (!entry) return;
        // Reserve BEFORE await; no late or concurrent response may mark this ID twice.
        entry.state = "completing";
        await this.machine.markRequestAsSent(entry.id, entry.type, JSON.stringify(nativeResponse));
        entry.state = "completed";
      }, true);
    };
    prepared.attempt.promise = run();
    try { await prepared.attempt.promise; }
    catch (error) { if (error instanceof VoiceGenerationInterrupted) prepared.attempt.promise = undefined; else this.stop("transport-or-completion-failure"); throw error; }
  }
  async flush(): Promise<void> {
    for (let round = 0; round < 4; round++) {
      const requests = await this.serial(async () => {
        const output = await this.machine.outgoingRequests();
        for (const request of output) await this.observe(request);
        return output;
      });
      if (!requests.length) return;
      for (const request of requests) await this.output(request);
    }
    this.stop("native-drain-limit"); throw new Error("Native voice drain bound.");
  }
  async query(memberIds: readonly string[]): Promise<void> {
    const output = await this.serial(async () => {
      if (memberIds.length > VOICE_LIMITS.members) throw new Error("Voice query bound.");
      const request = this.machine.queryKeysForUsers(memberIds.map(id => new C.UserId(this.peer(id).voiceUserId)));
      await this.observe(request); return request;
    });
    await this.output(output);
  }
  async requestVerification(memberId: string): Promise<string> {
    const revision = this.revision;
    await this.query([this.snapshot.memberId, memberId]);
    if (revision !== this.revision) throw new VoiceGenerationInterrupted();
    const result = await this.serial(async () => {
      const peer = voiceControlParty(this.peer(memberId));
      if (memberId === this.snapshot.memberId || this.flows.size >= VOICE_LIMITS.members) throw new Error("Voice verification bound.");
      const [request, output] = (await this.device(peer)).requestVerification([C.VerificationMethod.SasV1]);
      const handle = crypto.randomUUID();
      this.flows.set(handle, { handle, peer, generation: this.snapshot.generation, request, confirmed: false });
      await this.observe(output); return { handle, output };
    });
    await this.output(result.output);
    if (revision !== this.revision) throw new VoiceGenerationInterrupted();
    return result.handle;
  }
  private flow(handle: string): Flow {
    const flow = this.flows.get(handle);
    if (!flow || flow.generation !== this.snapshot.generation || !sameVoiceParty(flow.peer, voiceControlParty(this.peer(flow.peer.memberId))) || flow.request.otherUserId.toString() !== flow.peer.voiceUserId || (flow.request.otherDeviceId && flow.request.otherDeviceId.toString() !== flow.peer.voiceDeviceId)) throw new Error("Stale native voice flow.");
    return flow;
  }
  async verificationStep(handle: string, step: "accept" | "start" | "accept-sas" | "confirm" | "cancel"): Promise<void> {
    const outputs = await this.serial(async () => {
      const results = await (async () => {
      const flow = this.flow(handle);
      if (step === "accept") { const output = flow.request.acceptWithMethods([C.VerificationMethod.SasV1]); return output ? [output] : []; }
      if (step === "start") { const result = await flow.request.startSas(); if (!result) throw new Error("Missing native SAS start."); flow.sas = result[0]; return [result[1]]; }
      if (step === "cancel") { const output = flow.request.cancel(); return output ? [output] : []; }
      const sas = flow.request.getVerification();
      if (!(sas instanceof C.Sas) || sas.flowId !== flow.request.flowId || sas.otherUserId.toString() !== flow.peer.voiceUserId || sas.otherDeviceId.toString() !== flow.peer.voiceDeviceId || sas.userId.toString() !== this.snapshot.voiceUserId || sas.deviceId.toString() !== this.snapshot.voiceDeviceId) throw new Error("Native SAS identity mismatch.");
      flow.sas = sas;
      if (step === "accept-sas") { const output = sas.accept(); return output ? [output] : []; }
      if (!sas.canBePresented() || !sas.emojiIndex()) throw new Error("SAS not available for explicit comparison.");
      const output = await sas.confirm(); flow.confirmed = true; return output;
      })();
      for (const output of results) await this.observe(output);
      return results;
    });
    for (const output of outputs) await this.output(output);
  }
  verificationStates(): Promise<VoiceSasState[]> {
    return this.serial(() => [...this.flows.keys()].map(handle => {
      const flow = this.flow(handle), sas = flow.request.getVerification();
      if (sas instanceof C.Sas) flow.sas = sas;
      return { handle, peer: { ...flow.peer }, flowId: flow.request.flowId, ready: flow.request.isReady(), done: flow.confirmed && flow.request.isDone() && !!flow.sas?.isDone(), cancelled: flow.request.isCancelled(), confirmed: flow.confirmed, emojiIndices: flow.sas?.emojiIndex() ? Array.from(flow.sas.emojiIndex()!) : null };
    }));
  }
  /** Separate deliberate admission, never implied by transport delivery or native verified status. */
  admit(memberId: string): Promise<void> {
    return this.serial(async () => {
      const peer = voiceControlParty(this.peer(memberId));
      const flow = [...this.flows.values()].find(value => sameVoiceParty(value.peer, peer) && value.confirmed && value.request.isDone() && value.sas?.isDone());
      const identity = JSON.stringify(peer), revision = this.revision;
      const verified = (await this.device(peer)).isVerified();
      if (revision !== this.revision || this.transitioning) throw new VoiceGenerationInterrupted();
      this.assertCurrent();
      if ((!flow && !this.completedPeers.has(identity)) || !verified) throw new Error("Explicit completed voice SAS required.");
      this.completedPeers.add(identity); this.admitted.add(memberId);
    });
  }
  /** Caller supplies the explicitly chosen fresh media context; no key generation or media work. */
  setControlContext(epochId: string, memberIds: readonly string[]): Promise<void> {
    this.assertCurrent();
    this.transitioning = true; this.revision++; this.epochId = undefined; this.audience = [];
    this.options.onFence("audience-context-change");
    const selected = [...memberIds];
    return this.transitionDrain(structuredClone(this.snapshot), true, () => {
      z.uuid().parse(epochId);
      if (!selected.includes(this.snapshot.memberId) || new Set(selected).size !== selected.length || selected.length > VOICE_LIMITS.members || selected.some(id => id !== this.snapshot.memberId && !this.admitted.has(id))) throw new Error("Explicit current audience admission required.");
      this.epochId = epochId;
      this.audience = selected.map(id => voiceControlParty(this.peer(id))).sort((a, b) => a.memberId.localeCompare(b.memberId));
    }).catch(error => { this.stop("audience-transition-failed"); throw error; });
  }
  async sendControl(raw: VoiceOwnerControl): Promise<void> {
    const output = await this.serial(async () => {
      if (!this.epochId) throw new Error("Missing admitted voice context.");
      const value = validateVoiceOwnerControl(raw, this.snapshot, this.epochId, this.audience);
      if (value.sender.memberId !== this.snapshot.memberId || !this.admitted.has(value.recipient.memberId)) throw new Error("Voice control admission mismatch.");
      const peer = await this.device(value.recipient);
      if (!peer.isVerified()) throw new Error("Unverified native voice recipient.");
      const missing = await this.machine.getMissingSessions([new C.UserId(value.recipient.voiceUserId)]);
      if (missing) await this.observe(missing);
      return { value, missing };
    });
    if (output.missing) await this.output(output.missing);
    const request = await this.serial(async () => {
      if (!this.epochId) throw new Error("Missing admitted voice context.");
      const value = validateVoiceOwnerControl(output.value, this.snapshot, this.epochId, this.audience);
      const peer = await this.device(value.recipient);
      if (!peer.isVerified() || !this.admitted.has(value.recipient.memberId)) throw new Error("Unverified native voice recipient.");
      const encrypted = await peer.encryptToDeviceEvent(VOICE_CONTROL_EVENT, value, C.CollectStrategy.onlyTrustedDevices());
      const id = crypto.randomUUID();
      const request = new C.ToDeviceRequest(id, "m.room.encrypted", id, JSON.stringify({ messages: { [value.recipient.voiceUserId]: { [value.recipient.voiceDeviceId]: JSON.parse(encrypted) } } }));
      await this.observe(request); return request;
    });
    await this.output(request);
  }
  /** Returns authenticated typed data only. No prepared/key-ready/admission side effects. */
  async receive(): Promise<VoiceOwnerControl[]> {
    const revision = this.revision;
    const batch = syncSchema.parse(await this.exchange({ kind: "sync" }));
    const controls = await this.serial(async () => {
      if (revision !== this.revision) throw new VoiceGenerationInterrupted();
      const processed = await this.machine.receiveSyncChanges(JSON.stringify(batch.events), new C.DeviceLists([], []), new Map(Object.entries(batch.oneTimeKeys)), new Set(batch.unusedFallbackKeys), new C.DecryptionSettings(C.TrustRequirement.CrossSigned));
      const accepted: VoiceOwnerControl[] = [];
      for (const item of processed) {
        if (item instanceof C.PlainTextToDeviceEvent) {
          const event = envelopeSchema.parse(JSON.parse(item.rawEvent));
          const schema = voiceEventSchema(event.type);
          if (!event.type.startsWith("m.key.verification.") || !schema) throw new Error("Unsupported plaintext voice event.");
          schema.parse(event.content);
          const peer = this.snapshot.members.find(member => member.voiceUserId === event.sender && member.memberId !== this.snapshot.memberId);
          if (!peer || (event.content.from_device !== undefined && event.content.from_device !== peer.voiceDeviceId)) throw new Error("Unknown native SAS sender.");
          const transaction = z.string().min(1).max(128).parse(event.content.transaction_id);
          const known = [...this.flows.values()].find(flow => flow.peer.memberId === peer.memberId && flow.request.flowId === transaction && flow.generation === this.snapshot.generation);
          if (!known) {
            if (event.type !== "m.key.verification.request" || this.flows.size >= VOICE_LIMITS.members) throw new Error("Unknown native SAS flow.");
            const request = this.machine.getVerificationRequest(new C.UserId(peer.voiceUserId), transaction);
            if (!request) throw new Error("Missing native voice request.");
            const handle = crypto.randomUUID(); this.flows.set(handle, { handle, peer: voiceControlParty(peer), generation: this.snapshot.generation, request, confirmed: false });
          }
        } else if (item instanceof C.DecryptedToDeviceEvent) {
          const event = decryptedSchema.parse(JSON.parse(item.rawEvent));
          if (event.type !== VOICE_CONTROL_EVENT || !item.encryptionInfo.isSenderVerified() || !this.epochId) throw new Error("Unauthenticated voice control.");
          const value = validateVoiceOwnerControl(event.content, this.snapshot, this.epochId, this.audience);
          const peer = value.sender;
          if (!this.admitted.has(peer.memberId) || value.recipient.memberId !== this.snapshot.memberId || !sameVoiceParty(value.recipient, voiceControlParty(this.peer(this.snapshot.memberId))) || event.sender !== peer.voiceUserId || item.encryptionInfo.sender.toString() !== peer.voiceUserId || item.encryptionInfo.senderDevice?.toString() !== peer.voiceDeviceId || !(await this.device(peer)).isVerified()) throw new Error("Voice control sender/admission mismatch.");
          if (event.recipient !== this.snapshot.voiceUserId || event.recipient_keys.ed25519 !== this.machine.identityKeys.ed25519.toBase64() || event.sender_device_keys.user_id !== peer.voiceUserId || event.sender_device_keys.device_id !== peer.voiceDeviceId || event.keys.ed25519 !== event.sender_device_keys.keys[`ed25519:${peer.voiceDeviceId}`]) throw new Error("Voice Olm envelope mismatch.");
          accepted.push(value);
        } else throw new Error("Unsupported native voice processed event.");
      }
      return accepted;
    });
    await this.exchange({ kind: "ack", cursor: batch.cursor });
    await this.flush();
    if (revision !== this.revision) throw new VoiceGenerationInterrupted();
    return controls;
  }
  transition(next: VoiceSnapshot): Promise<void> {
    this.assertCurrent();
    const admissions = [...this.admitted].map(memberId => voiceControlParty(this.peer(memberId)));
    this.transitioning = true; this.revision++; this.admitted.clear(); this.epochId = undefined; this.audience = [];
    this.options.onFence("generation-transition");
    const snapshot = structuredClone(next);
    return this.transitionDrain(snapshot, false, () => {
      for (const peer of admissions) if (snapshot.members.some(member => sameVoiceParty(peer, voiceControlParty(member)))) this.admitted.add(peer.memberId);
    }).catch(error => { this.stop("transition-failed"); throw error; });
  }
  private async transitionDrain(next: VoiceSnapshot, sameGeneration = false, finalize?: () => void): Promise<void> {
    const outputs = await this.serial(async () => {
      validateSnapshot(next);
      if (next.callId !== this.snapshot.callId || next.memberId !== this.snapshot.memberId || next.joinNonce !== this.snapshot.joinNonce || next.voiceUserId !== this.snapshot.voiceUserId || next.voiceDeviceId !== this.snapshot.voiceDeviceId || (sameGeneration ? next.generation !== this.snapshot.generation : next.generation <= this.snapshot.generation)) throw new Error("Invalid retained voice transition.");
      const own = next.members.find(member => member.memberId === next.memberId);
      if (!own || own.userId !== this.options.accountId || own.joinNonce !== next.joinNonce || own.voiceUserId !== next.voiceUserId || own.voiceDeviceId !== next.voiceDeviceId) throw new Error("Lost voice enrollment.");
      const cancel: NativeRequest[] = [];
      for (const flow of this.flows.values()) if (flow.confirmed && flow.request.isDone() && flow.sas?.isDone() && (await this.device(flow.peer)).isVerified()) this.completedPeers.add(JSON.stringify(flow.peer));
      for (const flow of this.flows.values()) if (!flow.request.isDone() && !flow.request.isCancelled()) { const output = flow.request.cancel(); if (output) cancel.push(output); }
      // Only known old entries and narrowly recognized cancellation output can cross the fence.
      const queued = await this.machine.outgoingRequests();
      for (const output of [...cancel, ...queued]) await this.observe(output, true);
      this.snapshot = next;
      return [...this.registry.values()].filter(entry => entry.state !== "completed").map(entry => entry.request);
    }, true);
    for (const output of outputs) await this.output(output, output instanceof C.ToDeviceRequest, true);
    await this.serial(async () => {
      const pending = await this.machine.outgoingRequests();
      for (const output of pending) {
        if (!output.id || !this.registry.has(output.id) || this.registry.get(output.id)?.state !== "completed") throw new Error("Unsettled native transition output.");
      }
      this.flows.clear();
      for (const identity of this.completedPeers) if (!next.members.some(member => JSON.stringify(voiceControlParty(member)) === identity)) this.completedPeers.delete(identity);
      finalize?.(); this.transitioning = false;
    }, true);
  }
}
