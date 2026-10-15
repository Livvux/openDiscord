import { createHash, randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { z } from "zod";
import { EphemeralVoice, VoiceTransport } from "./ephemeral-voice";

export type NativeRequest = Awaited<ReturnType<C.OlmMachine["outgoingRequests"]>>[number];
type Operation = "send" | "retire";
export type Receipt = { generation: number; disposition: "processed-current" | "processed-retired" | "processed-absent" | "processed-refused"; enqueued: number; nativeResponse: Record<string, unknown>; digest: string };
type Pending = { request: NativeRequest; reject: (error: Error) => void };
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
class GenerationInterrupted extends Error {}

export function identity(owner: EphemeralVoice) {
  return createHash("sha256").update(JSON.stringify([owner.machine.identityKeys.curve25519.toBase64(), owner.machine.identityKeys.ed25519.toBase64()])).digest("hex");
}

/** An isolated in-memory test server; no application transport is imported. */
export class GenerationServer extends VoiceTransport {
  generation = 1;
  readonly enrolledUsers = new Set<string>();
  private readonly activeUsers = new Set<string>();
  private readonly owners = new Set<EphemeralVoice>();
  readonly retired: Receipt[] = [];
  private readonly generationReceipts = new Map<string, Receipt>();
  override enroll(owner: EphemeralVoice): void { super.enroll(owner); this.enrolledUsers.add(owner.binding.user); this.activeUsers.add(owner.binding.user); this.owners.add(owner); }
  override remove(owner: EphemeralVoice): void { super.remove(owner); this.activeUsers.delete(owner.binding.user); }
  advance(): void {
    this.generation++;
    for (const owner of this.owners) if (this.owns(owner.binding)) super.take(owner);
  }

  async process(owner: EphemeralVoice, request: NativeRequest, generation: number, operation: Operation, transportId: string): Promise<Receipt> {
    // Authorization and current generation precede receipt replay, including for retirement.
    if (!this.owns(owner.binding) || generation !== this.generation) throw new Error("Current sender/generation required.");
    if ((operation === "retire" && !request.id) || Buffer.byteLength(request.body) > 128_000) throw new Error("Bounded native request required.");
    const digest = createHash("sha256").update(JSON.stringify([owner.binding, generation, operation, request.id, request.type, request.body])).digest("hex");
    const key = `${owner.binding.member}:${transportId}`;
    const previous = this.generationReceipts.get(key);
    if (previous) {
      if (previous.digest !== digest) throw new Error("Immutable receipt mismatch.");
      return previous;
    }
    let nativeResponse: Record<string, unknown>, enqueued = 0;
    let disposition: Receipt["disposition"] = operation === "retire" ? "processed-retired" : "processed-current";
    if (operation === "retire") {
      if (!(request instanceof C.ToDeviceRequest)) throw new Error("Only ToDevice supports explicit retirement.");
      if (!/^m\.key\.verification\.(request|ready|start|accept|key|mac|done|cancel)$/.test(request.event_type) && request.event_type !== "m.room.encrypted") throw new Error("Unsupported retirement event.");
      const body: unknown = JSON.parse(request.body);
      if (!body || typeof body !== "object" || !("messages" in body) || !body.messages || typeof body.messages !== "object" || Array.isArray(body.messages)) throw new Error("Invalid retirement body.");
      const targets = Object.entries(body.messages);
      if (!targets.length || targets.length > 8) throw new Error("Retirement fanout bound.");
      const scoped = new RegExp(`^@voice_${this.call}_${uuid}:opendiscord\\.invalid$`);
      for (const [user, devices] of targets) {
        if (!scoped.test(user) || !devices || typeof devices !== "object" || Array.isArray(devices)) throw new Error("Same-call retirement targets required.");
        const entries = Object.entries(devices);
        if (entries.length !== 1 || !new RegExp(`^${uuid}$`).test(entries[0][0])) throw new Error("Exact bounded device required.");
      }
      // This branch cannot call submit/take or inspect any recipient's key record.
      nativeResponse = {};
    } else if (request instanceof C.KeysQueryRequest || request instanceof C.KeysClaimRequest || request instanceof C.SignatureUploadRequest) {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      const users = Object.keys(request instanceof C.KeysQueryRequest ? body.device_keys as object : request instanceof C.KeysClaimRequest ? body.one_time_keys as object : body);
      const scoped = new RegExp(`^@voice_${this.call}_${uuid}:opendiscord\\.invalid$`);
      if (!users.length || users.length > 8 || users.some((user) => !scoped.test(user))) throw new Error("Bounded same-call users required.");
      const absent = users.filter((user) => !this.activeUsers.has(user));
      if (absent.length && absent.length !== users.length) throw new Error("Mixed normal processing requires separate review.");
      if (!absent.length) nativeResponse = await super.submit(owner, request);
      else if (request instanceof C.KeysQueryRequest) {
        nativeResponse = { device_keys: Object.fromEntries(users.map((user) => [user, {}])), master_keys: {}, self_signing_keys: {}, user_signing_keys: {}, failures: {} };
        disposition = "processed-absent";
      } else if (request instanceof C.KeysClaimRequest) {
        nativeResponse = { one_time_keys: {}, failures: {} }; disposition = "processed-absent";
      } else {
        // Official /keys/signatures/upload: failures[user][key] is a standard Error.
        // Refused storage is M_FORBIDDEN, never the cryptographic M_INVALID_SIGNATURE.
        nativeResponse = { failures: Object.fromEntries(users.map((user) => [user, Object.fromEntries(Object.keys(body[user] as object).map((id) => [id, { errcode: "M_FORBIDDEN", error: "Target is outside current call scope." }]))])) };
        disposition = "processed-refused";
      }
    } else {
      const before = this.submitted.length;
      nativeResponse = await super.submit(owner, request);
      enqueued = this.submitted.slice(before).filter((entry) => entry.kind === "ToDevice").reduce((sum, entry) => sum + entry.recipients, 0);
    }
    const receipt: Receipt = { generation, digest, nativeResponse, enqueued, disposition };
    this.generationReceipts.set(key, receipt);
    if (operation === "retire") this.retired.push(receipt);
    if (this.generationReceipts.size > 512) throw new Error("Bounded server work exceeded.");
    return receipt;
  }
}

/** Public-API serial completion registry. Test pause models an unresolved HTTP request. */
export class GenerationDispatcher {
  readonly completions = new Map<string, number>();
  private readonly ids = new Map<string, string>();
  private readonly original: EphemeralVoice["out"];
  private readonly originalSync: EphemeralVoice["sync"];
  private pause?: { matches: (request: NativeRequest) => boolean; resolve: (pending: Pending) => void };
  private pending?: Pending;

  constructor(readonly owner: EphemeralVoice, readonly server: GenerationServer) {
    this.original = owner.out.bind(owner);
    this.originalSync = owner.sync.bind(owner);
    owner.out = (request) => this.send(request);
    owner.sync = () => this.sync();
  }
  private async sync(): Promise<void> {
    try { await this.receiveAndFlush(); }
    catch (error) {
      if (!(error instanceof GenerationInterrupted)) this.owner.close();
      throw error;
    }
  }
  private async receiveAndFlush(): Promise<void> {
    const generation = this.server.generation;
    const { events, count, fallback } = this.server.take(this.owner);
    const processed = await this.owner.machine.receiveSyncChanges(JSON.stringify(events), new C.DeviceLists([], []), new Map([["signed_curve25519", count]]), new Set(fallback ? ["signed_curve25519"] : []), new C.DecryptionSettings(C.TrustRequirement.CrossSigned));
    if (generation !== this.server.generation) throw new GenerationInterrupted("Old sync response fenced from current UI/control state.");
    for (const item of processed) {
      if (item instanceof C.PlainTextToDeviceEvent) {
        const event = z.object({ sender: z.string(), type: z.string(), content: z.object({ transaction_id: z.string() }).passthrough() }).parse(JSON.parse(item.rawEvent));
        if (!event.type.startsWith("m.key.verification.") || !this.owner.hasFlow(event.sender, event.content.transaction_id)) throw new Error("Unowned SAS event.");
      } else if (item instanceof C.DecryptedToDeviceEvent) {
        const binding = z.object({ call: z.uuid(), member: z.uuid(), user: z.string(), device: z.uuid() }).strict();
        const event = z.object({ sender: z.string(), type: z.literal("app.opendiscord.voice.proof"), content: z.object({ version: z.literal(1), purpose: z.literal("ephemeral-voice-proof"), sender: binding, recipient: binding, transaction: z.uuid(), message: z.string().max(128) }).strict() }).parse(JSON.parse(item.rawEvent));
        const payload = event.content;
        if (!item.encryptionInfo.isSenderVerified() || event.sender !== payload.sender.user || item.encryptionInfo.sender.toString() !== payload.sender.user || item.encryptionInfo.senderDevice?.toString() !== payload.sender.device || Object.keys(this.owner.binding).some((key) => payload.recipient[key as keyof typeof payload.recipient] !== this.owner.binding[key as keyof typeof this.owner.binding]) || !this.server.owns(payload.sender) || !this.owner.isAdmitted(payload.sender)) throw new Error("Verified control binding mismatch.");
        if (this.owner.received.some((old) => old.transaction === payload.transaction) || this.owner.received.length >= 64) throw new Error("Control transaction rejected.");
        this.owner.received.push(payload);
      } else throw new Error("Unsupported processed native event.");
    }
    // The accepted fixture's generic sync error handler disposes the owner even
    // for a deliberate generation interruption. This adapter keeps the public
    // machine alive while the interrupted test operation unwinds.
    await this.owner.flush();
  }
  private transportId(request: NativeRequest, operation: Operation): string {
    const key = JSON.stringify([this.server.generation, operation, request.id, request.type, request.body]);
    let id = this.ids.get(key);
    if (!id) { id = randomUUID(); this.ids.set(key, id); }
    return id;
  }
  async acceptResponse(request: NativeRequest, receipt: Receipt): Promise<void> {
    if (receipt.generation !== this.server.generation) throw new Error("Stale response fenced.");
    if (!request.id) return;
    if (this.completions.has(request.id)) return;
    await this.owner.machine.markRequestAsSent(request.id, request.type, JSON.stringify(receipt.nativeResponse));
    this.completions.set(request.id, 1);
  }
  pauseAt(phase: string): Promise<Pending> {
    return new Promise((resolve) => { this.pause = { matches: (request) => request instanceof C.ToDeviceRequest && request.event_type === `m.key.verification.${phase}`, resolve }; });
  }
  pauseAtType(type: C.RequestType): Promise<Pending> {
    return new Promise((resolve) => { this.pause = { matches: (request) => request.type === type, resolve }; });
  }
  async send(request: NativeRequest): Promise<void> {
    if (this.pause?.matches(request)) {
      const pause = this.pause; this.pause = undefined;
      await new Promise<void>((_resolve, reject) => { this.pending = { request, reject }; pause.resolve(this.pending); });
      return;
    }
    const generation = this.server.generation;
    const response = await this.server.process(this.owner, request, generation, "send", this.transportId(request, "send"));
    await this.acceptResponse(request, response);
  }
  async retire(request: NativeRequest): Promise<void> {
    const receipt = await this.server.process(this.owner, request, this.server.generation, "retire", this.transportId(request, "retire"));
    await this.acceptResponse(request, receipt);
  }
  async respondPending(): Promise<Receipt> {
    if (!this.pending) throw new Error("No pending native request.");
    const pending = this.pending;
    const receipt = await this.server.process(this.owner, pending.request, this.server.generation, "send", this.transportId(pending.request, "send"));
    await this.acceptResponse(pending.request, receipt);
    pending.reject(new GenerationInterrupted("Proof paused after actual response processing.")); this.pending = undefined;
    return receipt;
  }
  async cancelAndRetire(): Promise<void> {
    const cancel: C.ToDeviceRequest[] = [];
    // Public native handles only. Cancel unfinished flows even when the peer left.
    for (const user of this.server.enrolledUsers) {
      for (const flow of this.owner.machine.getVerificationRequests(new C.UserId(user))) {
        if (flow.isDone() || flow.isCancelled()) continue;
        const outgoing = flow.cancel();
        if (outgoing instanceof C.ToDeviceRequest) cancel.push(outgoing);
      }
    }
    const requests: NativeRequest[] = [...cancel, ...(await this.owner.machine.outgoingRequests()).filter((r) => r instanceof C.ToDeviceRequest)];
    if (this.pending?.request instanceof C.ToDeviceRequest) requests.unshift(this.pending.request);
    const seen = new Set<string>();
    for (const request of requests) {
      if (!request.id || seen.has(request.id)) continue;
      seen.add(request.id); await this.retire(request);
    }
    this.pending?.reject(new GenerationInterrupted("Generation changed; old operation interrupted."));
    this.pending = undefined; this.pause = undefined;
  }
  release(): void {
    this.pending?.reject(new Error("Proof disposed.")); this.pending = undefined;
    this.owner.out = this.original;
    this.owner.sync = this.originalSync;
  }
}
