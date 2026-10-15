import { randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { z } from "zod";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const object = z.record(z.string(), z.unknown());
const signatures = z.record(z.string(), z.record(z.string(), z.string()));
const signedKey = z.object({ user_id: z.string(), keys: z.record(z.string(), z.string()), signatures: signatures.optional() }).passthrough();
type SignedKey = z.infer<typeof signedKey>;
type Request = Awaited<ReturnType<C.OlmMachine["outgoingRequests"]>>[number];
const sasTypes = new Set(["request", "ready", "start", "accept", "key", "mac", "done", "cancel"].map((part) => `m.key.verification.${part}`));
const CONTROL = "app.opendiscord.voice.proof";
const bindingSchema = z.object({ call: z.uuid(), member: z.uuid(), user: z.string(), device: z.uuid() }).strict();
export type Binding = z.infer<typeof bindingSchema>;
const controlSchema = z.object({ version: z.literal(1), purpose: z.literal("ephemeral-voice-proof"), sender: bindingSchema, recipient: bindingSchema, transaction: z.uuid(), message: z.string().max(128) }).strict();
export type Control = z.infer<typeof controlSchema>;
type Envelope = { sender: string; type: string; content: Record<string, unknown> };
type RecordEntry = { owner: EphemeralVoice; device?: SignedKey; signing: Record<string, SignedKey>; prekeys: Map<string, unknown>; claimed: Set<string>; fallback: boolean; inbox: Envelope[] };

function parse(body: string): Record<string, unknown> {
  if (Buffer.byteLength(body) > 128_000) throw new Error("Fixture body limit.");
  return object.parse(JSON.parse(body));
}
function entries(value: unknown, cap = 8): [string, unknown][] {
  const list = Object.entries(object.parse(value));
  if (list.length > cap) throw new Error("Fixture recipient limit.");
  return list;
}
function same(a: Binding, b: Binding): boolean {
  return a.call === b.call && a.member === b.member && a.user === b.user && a.device === b.device;
}

/** Test-only call directory. Never imports application transport or accesses a persistent DM store. */
export class VoiceTransport {
  readonly call = randomUUID();
  readonly submitted: { kind: string; sender: string; recipients: number }[] = [];
  private readonly records = new Map<string, RecordEntry>();
  private readonly receipts = new Map<string, Record<string, unknown>>();

  enroll(owner: EphemeralVoice): void {
    if (this.records.size >= 8 || owner.binding.call !== this.call || this.records.has(owner.binding.user)) throw new Error("Fixture enrollment mismatch.");
    this.records.set(owner.binding.user, { owner, signing: {}, prekeys: new Map(), claimed: new Set(), fallback: false, inbox: [] });
  }
  private record(user: string, device?: string): RecordEntry {
    const record = this.records.get(user);
    if (!record || record.owner.closed || (device !== undefined && record.owner.binding.device !== device)) throw new Error("Destination is outside this active call.");
    return record;
  }
  owns(binding: Binding): boolean {
    const value = this.records.get(binding.user);
    return !!value && !value.owner.closed && same(value.owner.binding, binding);
  }
  signing(owner: EphemeralVoice, request: C.UploadSigningKeysRequest): void {
    const record = this.record(owner.binding.user, owner.binding.device);
    const body = parse(request.body);
    for (const name of ["master_key", "self_signing_key", "user_signing_key"]) {
      const key = signedKey.parse(body[name]);
      if (key.user_id !== owner.binding.user) throw new Error("Signing identity mismatch.");
      record.signing[name] = key;
    }
    this.submitted.push({ kind: "signing", sender: owner.binding.member, recipients: 0 });
  }
  async submit(owner: EphemeralVoice, request: Request): Promise<Record<string, unknown>> {
    const own = this.record(owner.binding.user, owner.binding.device);
    const allowed = [C.RequestType.KeysUpload, C.RequestType.KeysQuery, C.RequestType.KeysClaim, C.RequestType.SignatureUpload, C.RequestType.ToDevice];
    if (!allowed.includes(request.type)) throw new Error("Unsupported native outgoing request.");
    const receipt = `${owner.binding.device}:${request.type}:${request.id}`;
    const existing = this.receipts.get(receipt);
    if (request.id && existing) return existing;
    const body = parse(request.body);
    let response: Record<string, unknown>;
    let targets = 0;
    if (request instanceof C.KeysUploadRequest) {
      if (body.device_keys) {
        const device = signedKey.extend({ device_id: z.string() }).parse(body.device_keys);
        if (device.user_id !== owner.binding.user || device.device_id !== owner.binding.device) throw new Error("Upload identity mismatch.");
        own.device = device;
      }
      for (const [id, key] of entries(body.one_time_keys ?? {}, 100)) if (!own.claimed.has(id)) own.prekeys.set(id, key);
      if (entries(body.fallback_keys ?? {}, 1).length) own.fallback = true;
      if (own.prekeys.size > 100) throw new Error("Fixture prekey cap.");
      response = { one_time_key_counts: { signed_curve25519: own.prekeys.size } };
    } else if (request instanceof C.KeysQueryRequest) {
      const device_keys: Record<string, unknown> = {}, master_keys: Record<string, unknown> = {}, self_signing_keys: Record<string, unknown> = {}, user_signing_keys: Record<string, unknown> = {};
      for (const [user, requested] of entries(body.device_keys)) {
        const record = this.record(user);
        const ids = z.array(z.string()).max(1).parse(requested);
        if (ids.some((id) => id !== record.owner.binding.device)) throw new Error("Unknown queried device.");
        device_keys[user] = record.device ? { [record.owner.binding.device]: record.device } : {};
        if (record.signing.master_key) master_keys[user] = record.signing.master_key;
        if (record.signing.self_signing_key) self_signing_keys[user] = record.signing.self_signing_key;
        if (user === owner.binding.user && record.signing.user_signing_key) user_signing_keys[user] = record.signing.user_signing_key;
        targets++;
      }
      response = { device_keys, master_keys, self_signing_keys, user_signing_keys, failures: {} };
    } else if (request instanceof C.KeysClaimRequest) {
      const one_time_keys: Record<string, unknown> = {};
      for (const [user, devices] of entries(body.one_time_keys)) {
        for (const [device, algorithm] of entries(devices, 1)) {
          if (algorithm !== "signed_curve25519") throw new Error("Unsupported prekey algorithm.");
          const record = this.record(user, device), next = record.prekeys.entries().next().value;
          if (!next) throw new Error("No fixture prekey.");
          const [id, key] = next;
          record.prekeys.delete(id); record.claimed.add(id);
          one_time_keys[user] = { [device]: { [id]: key } }; targets++;
        }
      }
      response = { one_time_keys, failures: {} };
    } else if (request instanceof C.SignatureUploadRequest) {
      for (const [user, values] of entries(body)) {
        const record = this.record(user);
        for (const [id, value] of entries(values, 2)) {
          const signed = signedKey.parse(value);
          if (signed.user_id !== user) throw new Error("Signature identity mismatch.");
          const target = id === record.owner.binding.device ? record.device : Object.values(record.signing).find((key) => Object.values(key.keys).includes(id));
          if (!target) throw new Error("Unknown signature target.");
          const ownSignature = signed.signatures?.[owner.binding.user];
          if (!ownSignature) throw new Error("Missing own signature.");
          target.signatures = { ...target.signatures, [owner.binding.user]: ownSignature }; targets++;
        }
      }
      response = { failures: {} };
    } else if (request instanceof C.ToDeviceRequest) {
      if (!sasTypes.has(request.event_type) && request.event_type !== "m.room.encrypted") throw new Error("Unsupported native event type.");
      for (const [user, devices] of entries(body.messages)) for (const [device, raw] of entries(devices, 1)) {
        const target = this.record(user, device), content = object.parse(raw);
        if (target.inbox.length >= 64) throw new Error("Fixture mailbox cap.");
        if (sasTypes.has(request.event_type)) {
          const flow = z.string().min(1).max(256).parse(content.transaction_id);
          if (!owner.hasFlow(user, flow)) throw new Error("Unowned SAS output.");
          if (request.event_type === "m.key.verification.request") target.owner.registerFlow(owner.binding.user, flow);
          else if (!target.owner.hasFlow(owner.binding.user, flow)) throw new Error("Unowned SAS destination.");
        } else if (!owner.isAdmitted(target.owner.binding)) throw new Error("Unadmitted encrypted output.");
        target.inbox.push({ sender: owner.binding.user, type: request.event_type, content }); targets++;
      }
      response = {};
    } else throw new Error("Unexpected native request class.");
    this.submitted.push({ kind: C.RequestType[request.type], sender: owner.binding.member, recipients: targets });
    if (request.id) this.receipts.set(receipt, response);
    if (this.submitted.length > 512) throw new Error("Fixture work cap.");
    return response;
  }
  take(owner: EphemeralVoice) {
    const record = this.record(owner.binding.user, owner.binding.device);
    return { events: record.inbox.splice(0), count: record.prekeys.size, fallback: record.fallback };
  }
  queued(owner: EphemeralVoice): number { return this.record(owner.binding.user, owner.binding.device).inbox.length; }
  remove(owner: EphemeralVoice): void { this.records.delete(owner.binding.user); }
}

/** Independent memory-only voice owner, deliberately unavailable to production imports. */
export class EphemeralVoice {
  closed = false;
  readonly received: Control[] = [];
  private readonly flows = new Map<string, Set<string>>();
  private readonly admitted = new Map<string, Binding>();
  private readonly seen = new Set<string>();
  private constructor(readonly transport: VoiceTransport, readonly binding: Binding, readonly machine: C.OlmMachine) {}
  static async open(transport: VoiceTransport, previous?: Binding): Promise<EphemeralVoice> {
    const member = randomUUID(), device = randomUUID();
    const binding = previous ? { ...previous } : { call: transport.call, member, device, user: `@voice_${transport.call}_${member}:opendiscord.invalid` };
    const machine = await C.OlmMachine.initialize(new C.UserId(binding.user), new C.DeviceId(binding.device), undefined, undefined, logger);
    machine.roomKeyRequestsEnabled = false; machine.roomKeyForwardingEnabled = false;
    const owner = new EphemeralVoice(transport, binding, machine);
    transport.enroll(owner);
    try {
      await owner.flush();
      const bootstrap = await machine.bootstrapCrossSigning(false);
      if (bootstrap.uploadKeysRequest) await owner.out(bootstrap.uploadKeysRequest);
      transport.signing(owner, bootstrap.uploadSigningKeysRequest);
      await owner.out(bootstrap.uploadSignaturesRequest);
      await owner.query([owner]);
      return owner;
    } catch (error) { owner.close(); throw error; }
  }
  hasFlow(user: string, flow: string): boolean { return this.flows.get(user)?.has(flow) ?? false; }
  registerFlow(user: string, flow: string): void {
    if (this.flows.size >= 8 || (this.flows.get(user)?.size ?? 0) >= 8) throw new Error("Fixture flow cap.");
    const flows = this.flows.get(user) ?? new Set<string>(); flows.add(flow); this.flows.set(user, flows);
  }
  isAdmitted(binding: Binding): boolean { const admitted = this.admitted.get(binding.user); return !!admitted && same(admitted, binding); }
  async device(peer: EphemeralVoice) {
    if (!this.transport.owns(peer.binding)) throw new Error("Peer is not in this call.");
    const device = await this.machine.getDevice(new C.UserId(peer.binding.user), new C.DeviceId(peer.binding.device));
    if (!device) throw new Error("Missing native device.");
    return device;
  }
  async admit(peer: EphemeralVoice): Promise<void> {
    if (!(await this.device(peer)).isVerified()) throw new Error("Fresh voice SAS required.");
    this.admitted.set(peer.binding.user, { ...peer.binding });
  }
  async out(request: Request): Promise<void> {
    if (this.closed) throw new Error("Voice owner is closed.");
    try {
      const response = await this.transport.submit(this, request);
      if (request.id) await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(response));
    } catch (error) { this.close(); throw error; }
  }
  async flush(): Promise<void> {
    for (let round = 0; round < 8; round++) {
      const requests = await this.machine.outgoingRequests();
      if (!requests.length) return;
      for (const request of requests) await this.out(request);
    }
    this.close(); throw new Error("Native queue did not settle.");
  }
  async query(peers: EphemeralVoice[]): Promise<void> {
    await this.out(this.machine.queryKeysForUsers(peers.map((peer) => new C.UserId(peer.binding.user))));
  }
  async sync(): Promise<void> {
    const { events, count, fallback } = this.transport.take(this);
    try {
      const processed = await this.machine.receiveSyncChanges(JSON.stringify(events), new C.DeviceLists([], []), new Map([["signed_curve25519", count]]), new Set(fallback ? ["signed_curve25519"] : []), new C.DecryptionSettings(C.TrustRequirement.CrossSigned));
      for (const item of processed) {
        if (item instanceof C.PlainTextToDeviceEvent) {
          const event = z.object({ sender: z.string(), type: z.string(), content: object }).parse(JSON.parse(item.rawEvent));
          if (!sasTypes.has(event.type) || !this.hasFlow(event.sender, z.string().parse(event.content.transaction_id))) throw new Error("Unowned plaintext event.");
        } else if (item instanceof C.DecryptedToDeviceEvent) {
          if (!item.encryptionInfo.isSenderVerified()) throw new Error("Native sender is unverified.");
          const event = z.object({ sender: z.string(), type: z.literal(CONTROL), content: controlSchema }).parse(JSON.parse(item.rawEvent));
          const payload = event.content;
          if (item.encryptionInfo.sender.toString() !== payload.sender.user || item.encryptionInfo.senderDevice?.toString() !== payload.sender.device || event.sender !== payload.sender.user || !same(payload.recipient, this.binding) || !this.transport.owns(payload.sender) || !this.isAdmitted(payload.sender)) throw new Error("Verified control binding mismatch.");
          if (this.seen.has(payload.transaction) || this.seen.size >= 64) throw new Error("Control transaction rejected.");
          this.seen.add(payload.transaction); this.received.push(payload);
        } else throw new Error("Unsupported native processed event.");
      }
      await this.flush();
    } catch (error) { this.close(); throw error; }
  }
  async send(peer: EphemeralVoice, message: string): Promise<void> {
    if (!this.isAdmitted(peer.binding)) throw new Error("Peer has not been explicitly admitted.");
    const device = await this.device(peer);
    if (!device.isVerified()) throw new Error("Fresh voice SAS required.");
    const claim = await this.machine.getMissingSessions([new C.UserId(peer.binding.user)]);
    if (claim) await this.out(claim);
    const payload = controlSchema.parse({ version: 1, purpose: "ephemeral-voice-proof", sender: this.binding, recipient: peer.binding, transaction: randomUUID(), message });
    const content = await device.encryptToDeviceEvent(CONTROL, payload, C.CollectStrategy.onlyTrustedDevices());
    const id = randomUUID();
    await this.out(new C.ToDeviceRequest(id, "m.room.encrypted", id, JSON.stringify({ messages: { [peer.binding.user]: { [peer.binding.device]: JSON.parse(content) } } })));
  }
  verification(peer: EphemeralVoice, flow: string): C.VerificationRequest {
    if (!this.hasFlow(peer.binding.user, flow)) throw new Error("Unknown SAS flow.");
    const request = this.machine.getVerificationRequest(new C.UserId(peer.binding.user), flow);
    if (!request) throw new Error("Missing native SAS flow.");
    return request;
  }
  sas(peer: EphemeralVoice, flow: string): C.Sas {
    const sas = this.verification(peer, flow).getVerification();
    if (!(sas instanceof C.Sas)) throw new Error("Native SAS not ready.");
    return sas;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.admitted.clear(); this.flows.clear(); this.seen.clear(); this.received.length = 0;
    this.transport.remove(this); this.machine.close();
  }
}

/** Automated comparison is a fixture oracle, not a replacement for independent human comparison. */
export async function verifyPair(a: EphemeralVoice, b: EphemeralVoice): Promise<void> {
  await a.query([a, b]); await b.query([a, b]);
  const [request, outgoing] = (await a.device(b)).requestVerification([C.VerificationMethod.SasV1]);
  const flow = request.flowId;
  a.registerFlow(b.binding.user, flow); await a.out(outgoing); await b.sync();
  const accepted = b.verification(a, flow).acceptWithMethods([C.VerificationMethod.SasV1]);
  if (!accepted) throw new Error("Native SAS acceptance missing.");
  await b.out(accepted); await a.sync();
  const started = await a.verification(b, flow).startSas();
  if (!started) throw new Error("Native SAS start missing.");
  await a.out(started[1]); await b.sync();
  const sasAccept = b.sas(a, flow).accept(); if (sasAccept) await b.out(sasAccept);
  await a.sync(); await b.sync(); await a.sync();
  const left = a.sas(b, flow).decimals(), right = b.sas(a, flow).decimals();
  if (!left || !right || Array.from(left).join() !== Array.from(right).join()) throw new Error("Independent SAS comparison failed.");
  for (const item of await a.sas(b, flow).confirm()) await a.out(item);
  for (const item of await b.sas(a, flow).confirm()) await b.out(item);
  await a.sync(); await b.sync(); await a.sync(); await b.sync();
  if (!a.verification(b, flow).isDone() || !b.verification(a, flow).isDone()) throw new Error("Native SAS not complete.");
  await a.query([a, b]); await b.query([a, b]);
  if (!(await a.device(b)).isVerified() || !(await b.device(a)).isVerified()) throw new Error("Native trust did not settle.");
}
