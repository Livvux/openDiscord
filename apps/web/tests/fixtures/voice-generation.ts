import { createHash, randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { z } from "zod";
import { EphemeralVoice, VoiceTransport } from "./ephemeral-voice";

export type NativeRequest = Awaited<ReturnType<C.OlmMachine["outgoingRequests"]>>[number];
type Operation = "send" | "retire";
export type Receipt = { generation: number; disposition: "processed-current" | "processed-retired" | "processed-absent" | "processed-refused"; enqueued: number; nativeResponse: Record<string, unknown>; digest: string };
type Pending = { request: NativeRequest; reject: (error: Error) => void };
const jsonObject = z.record(z.string(), z.unknown());
type PublicDirectory = { device?: Record<string, unknown>; signing: Record<string, Record<string, unknown>>; prekeys: Map<string, unknown>; claimed: Set<string>; deviceId: string; fallback: boolean };
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
class GenerationInterrupted extends Error {}
const generationControl = z.object({
  purpose: z.literal("voice-generation-proof"), call: z.uuid(), generation: z.number().int().positive(), epoch: z.uuid(),
  sender: z.string(), senderDevice: z.uuid(), recipient: z.string(), recipientDevice: z.uuid(),
  audience: z.array(z.uuid()).length(2), transaction: z.uuid(), action: z.literal("prepared"),
}).strict();
const GENERATION_CONTROL = "app.opendiscord.voice.generation-proof";
function sameCallUser(user: string, call: string): boolean {
  const match = new RegExp(`^@voice_${call}_(${uuid}):opendiscord\\.invalid$`).exec(user);
  return !!match && z.uuid().safeParse(match[1]).success;
}

/** No splitting or partial processing of unsupported native ToDevice fanout. */
export function validateGenerationToDevice(body: unknown, call: string): void {
  const messages = z.object({ messages: z.record(z.string(), z.record(z.string(), z.unknown())) }).strict().parse(body).messages;
  const targets = Object.entries(messages);
  if (targets.length !== 1) throw new Error("Only single-target native ToDevice is supported.");
  const [user, devices] = targets[0];
  if (!sameCallUser(user, call)) throw new Error("Same-call target required.");
  const ids = Object.keys(devices);
  if (ids.length !== 1 || !new RegExp(`^${uuid}$`).test(ids[0]) || !z.uuid().safeParse(ids[0]).success) throw new Error("Only an exact single device is supported.");
}

/** Normal native encryption of a benign purpose-bound control, no media keys. */
export async function encryptGenerationControl(sender: EphemeralVoice, recipient: EphemeralVoice, generation: number, epoch: string): Promise<C.ToDeviceRequest> {
  const claim = await sender.machine.getMissingSessions([new C.UserId(recipient.binding.user)]);
  if (claim) await sender.out(claim);
  const content = generationControl.parse({ purpose: "voice-generation-proof", call: sender.binding.call, generation, epoch, sender: sender.binding.user, senderDevice: sender.binding.device, recipient: recipient.binding.user, recipientDevice: recipient.binding.device, audience: [sender.binding.member, recipient.binding.member], transaction: randomUUID(), action: "prepared" });
  const encrypted = await (await sender.device(recipient)).encryptToDeviceEvent(GENERATION_CONTROL, content, C.CollectStrategy.onlyTrustedDevices());
  const id = randomUUID();
  return new C.ToDeviceRequest(id, "m.room.encrypted", id, JSON.stringify({ messages: { [recipient.binding.user]: { [recipient.binding.device]: JSON.parse(encrypted) } } }));
}

/** Apply current app bindings after genuine native decryption, before any readiness effect. */
export async function receiveGenerationControls(recipient: EphemeralVoice, sender: EphemeralVoice, events: ReturnType<VoiceTransport["take"]>, generation: number, epoch: string): Promise<number> {
  const processed = await recipient.machine.receiveSyncChanges(JSON.stringify(events.events), new C.DeviceLists([], []), new Map([["signed_curve25519", events.count]]), new Set(events.fallback ? ["signed_curve25519"] : []), new C.DecryptionSettings(C.TrustRequirement.CrossSigned));
  let accepted = 0;
  for (const item of processed) {
    if (!(item instanceof C.DecryptedToDeviceEvent) || !item.encryptionInfo.isSenderVerified()) throw new Error("Genuine verified decryption required.");
    const event = z.object({ sender: z.string(), type: z.literal(GENERATION_CONTROL), content: generationControl }).parse(JSON.parse(item.rawEvent));
    const payload = event.content;
    if (event.sender !== sender.binding.user || item.encryptionInfo.sender.toString() !== sender.binding.user || item.encryptionInfo.senderDevice?.toString() !== sender.binding.device || payload.sender !== sender.binding.user || payload.senderDevice !== sender.binding.device || payload.recipient !== recipient.binding.user || payload.recipientDevice !== recipient.binding.device || payload.call !== recipient.binding.call || !recipient.transport.owns(sender.binding) || !recipient.isAdmitted(sender.binding)) throw new Error("Exact control binding required.");
    if (payload.generation !== generation || payload.epoch !== epoch || payload.audience.join() !== [sender.binding.member, recipient.binding.member].join()) continue;
    accepted++;
  }
  return accepted;
}

export function identity(owner: EphemeralVoice) {
  return createHash("sha256").update(JSON.stringify([owner.machine.identityKeys.curve25519.toBase64(), owner.machine.identityKeys.ed25519.toBase64()])).digest("hex");
}

/** An isolated in-memory test server; no application transport is imported. */
export class GenerationServer extends VoiceTransport {
  generation = 1;
  readonly enrolledUsers = new Set<string>();
  private readonly activeUsers = new Set<string>();
  private readonly owners = new Set<EphemeralVoice>();
  private readonly publicDirectory = new Map<string, PublicDirectory>();
  readonly retired: Receipt[] = [];
  readonly signatureWrites = new Map<string, number>();
  private readonly generationReceipts = new Map<string, Receipt>();
  override enroll(owner: EphemeralVoice): void {
    super.enroll(owner); this.enrolledUsers.add(owner.binding.user); this.activeUsers.add(owner.binding.user); this.owners.add(owner);
    this.publicDirectory.set(owner.binding.user, { signing: {}, prekeys: new Map(), claimed: new Set(), deviceId: owner.binding.device, fallback: false });
  }
  override remove(owner: EphemeralVoice): void { super.remove(owner); this.activeUsers.delete(owner.binding.user); this.publicDirectory.delete(owner.binding.user); }
  override signing(owner: EphemeralVoice, request: C.UploadSigningKeysRequest): void {
    super.signing(owner, request);
    const record = this.publicDirectory.get(owner.binding.user);
    if (!record) throw new Error("Missing own public directory.");
    const body = jsonObject.parse(JSON.parse(request.body));
    for (const name of ["master_key", "self_signing_key", "user_signing_key"]) record.signing[name] = jsonObject.parse(body[name]);
  }
  override async submit(owner: EphemeralVoice, request: NativeRequest): Promise<Record<string, unknown>> {
    return (await this.process(owner, request, this.generation, "send", randomUUID())).nativeResponse;
  }
  override take(owner: EphemeralVoice): ReturnType<VoiceTransport["take"]> {
    const incoming = super.take(owner), own = this.publicDirectory.get(owner.binding.user);
    if (!own) throw new Error("Missing own public directory.");
    return { ...incoming, count: own.prekeys.size, fallback: own.fallback };
  }
  advance(): void {
    this.generation++;
    for (const owner of this.owners) if (this.owns(owner.binding)) super.take(owner);
  }

  async process(owner: EphemeralVoice, request: NativeRequest, generation: number, operation: Operation, transportId: string): Promise<Receipt> {
    // Authorization and current generation precede receipt replay, including for retirement.
    if (!this.owns(owner.binding) || generation !== this.generation) throw new Error("Current sender/generation required.");
    if ((operation === "retire" && !request.id) || Buffer.byteLength(request.body) > 128_000) throw new Error("Bounded native request required.");
    if (request instanceof C.ToDeviceRequest) validateGenerationToDevice(JSON.parse(request.body), this.call);
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
      // This branch cannot call submit/take or inspect any recipient's key record.
      nativeResponse = {};
    } else if (request instanceof C.KeysUploadRequest) {
      // Own uploads are genuine storage only, including real remaining key counts.
      const own = this.publicDirectory.get(owner.binding.user);
      if (!own) throw new Error("Missing own public directory.");
      const body = jsonObject.parse(JSON.parse(request.body));
      if (body.device_keys) {
        const device = jsonObject.parse(body.device_keys);
        if (device.user_id !== owner.binding.user || device.device_id !== owner.binding.device) throw new Error("Own upload identity mismatch.");
        own.device = device;
      }
      for (const [id, key] of Object.entries(jsonObject.parse(body.one_time_keys ?? {}))) if (!own.claimed.has(id)) own.prekeys.set(id, key);
      if (own.prekeys.size > 100) throw new Error("Own prekey storage bound.");
      if (Object.keys(jsonObject.parse(body.fallback_keys ?? {})).length) own.fallback = true;
      nativeResponse = { one_time_key_counts: { signed_curve25519: own.prekeys.size } };
      this.submitted.push({ kind: "KeysUpload", sender: owner.binding.member, recipients: 0 });
    } else if (request instanceof C.KeysQueryRequest || request instanceof C.KeysClaimRequest || request instanceof C.SignatureUploadRequest) {
      const body = jsonObject.parse(JSON.parse(request.body));
      const map = request instanceof C.KeysQueryRequest ? jsonObject.parse(body.device_keys) : request instanceof C.KeysClaimRequest ? jsonObject.parse(body.one_time_keys) : body;
      const users = Object.keys(map);
      if (!users.length || users.length > 8 || users.some((user) => !sameCallUser(user, this.call))) throw new Error("Bounded same-call users required.");
      const absent = users.filter((user) => !this.activeUsers.has(user));
      if (request instanceof C.KeysQueryRequest) {
        const device_keys: Record<string, unknown> = {}, master_keys: Record<string, unknown> = {}, self_signing_keys: Record<string, unknown> = {}, user_signing_keys: Record<string, unknown> = {};
        for (const user of users) {
          const ids = z.array(z.string()).max(1).parse(map[user]);
          const record = this.activeUsers.has(user) ? this.publicDirectory.get(user) : undefined;
          if (record && ids.some((id) => id !== record.deviceId)) throw new Error("Exact current queried device required.");
          device_keys[user] = record?.device ? { [record.deviceId]: record.device } : {};
          if (record?.signing.master_key) master_keys[user] = record.signing.master_key;
          if (record?.signing.self_signing_key) self_signing_keys[user] = record.signing.self_signing_key;
          if (user === owner.binding.user && record?.signing.user_signing_key) user_signing_keys[user] = record.signing.user_signing_key;
        }
        nativeResponse = { device_keys, master_keys, self_signing_keys, user_signing_keys, failures: {} };
        if (absent.length) disposition = "processed-absent";
      } else if (request instanceof C.KeysClaimRequest) {
        const selected: { user: string; device: string; record: PublicDirectory; id: string; key: unknown }[] = [];
        for (const user of users) {
          const devices = Object.entries(jsonObject.parse(map[user]));
          if (devices.length !== 1) throw new Error("Bounded exact claim device required.");
          const [device, algorithm] = devices[0];
          if (algorithm !== "signed_curve25519" || !new RegExp(`^${uuid}$`).test(device)) throw new Error("Exact claim algorithm/device required.");
          const record = this.activeUsers.has(user) ? this.publicDirectory.get(user) : undefined;
          if (!record) continue;
          if (record.deviceId !== device) throw new Error("Current claim device mismatch.");
          const next = record.prekeys.entries().next().value;
          if (next) selected.push({ user, device, record, id: next[0], key: next[1] });
        }
        const one_time_keys: Record<string, unknown> = {};
        for (const item of selected) {
          item.record.prekeys.delete(item.id); item.record.claimed.add(item.id);
          one_time_keys[item.user] = { [item.device]: { [item.id]: item.key } };
        }
        nativeResponse = { one_time_keys, failures: {} }; if (absent.length) disposition = "processed-absent";
      } else {
        // Official /keys/signatures/upload: failures[user][key] is a standard Error.
        // Refused storage is M_FORBIDDEN, never the cryptographic M_INVALID_SIGNATURE.
        const failures: Record<string, Record<string, unknown>> = {};
        const writes: { user: string; target: Record<string, unknown>; signatures: Record<string, unknown> }[] = [];
        for (const user of users) for (const [id, value] of Object.entries(jsonObject.parse(body[user]))) {
          const signed = jsonObject.parse(value);
          if (signed.user_id !== user) throw new Error("Signature user mismatch.");
          const record = this.activeUsers.has(user) ? this.publicDirectory.get(user) : undefined;
          if (!record) { (failures[user] ??= {})[id] = { errcode: "M_FORBIDDEN", error: "Target is outside current call scope." }; continue; }
          const target = id === record.deviceId ? record.device : Object.values(record.signing).find((key) => Object.values(jsonObject.parse(key.keys)).includes(id));
          if (!target) throw new Error("Unknown current signature target.");
          const ownSignature = jsonObject.parse(jsonObject.parse(signed.signatures)[owner.binding.user]);
          writes.push({ user, target, signatures: ownSignature });
        }
        for (const write of writes) {
          write.target.signatures = { ...jsonObject.parse(write.target.signatures ?? {}), [owner.binding.user]: { ...jsonObject.parse(jsonObject.parse(write.target.signatures ?? {})[owner.binding.user] ?? {}), ...write.signatures } };
          this.signatureWrites.set(write.user, (this.signatureWrites.get(write.user) ?? 0) + 1);
        }
        nativeResponse = { failures }; if (absent.length) disposition = "processed-refused";
      }
      if (!absent.length) this.submitted.push({ kind: C.RequestType[request.type], sender: owner.binding.member, recipients: users.length });
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
    const operation = receipt.disposition === "processed-retired" ? "retire" : "send";
    const digest = createHash("sha256").update(JSON.stringify([this.owner.binding, receipt.generation, operation, request.id, request.type, request.body])).digest("hex");
    if (digest !== receipt.digest) throw new Error("Response does not bind original native request.");
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
    try { await this.dispatch(request); }
    catch (error) {
      if (!(error instanceof GenerationInterrupted)) this.owner.close();
      throw error;
    }
  }
  private async dispatch(request: NativeRequest): Promise<void> {
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
