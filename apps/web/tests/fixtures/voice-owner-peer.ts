import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { z } from "zod";
import { VOICE_LIMITS, voiceCryptoSchema, voiceEventSchema, type VoiceBinding, type VoiceCryptoRequest, type VoiceMember, type VoiceSnapshot } from "../../src/lib/voice/contracts";
import type { VoiceOwnerTransport } from "../../src/lib/voice/crypto-owner";
import { VOICE_CONTROL_EVENT } from "../../src/lib/voice/owner-control";

type Native = Awaited<ReturnType<C.OlmMachine["outgoingRequests"]>>[number];
const object = z.record(z.string(), z.unknown());
const signed = z.object({ user_id: z.string(), keys: z.record(z.string(), z.string()), signatures: z.record(z.string(), z.record(z.string(), z.string())).optional() }).passthrough();
type Signed = z.infer<typeof signed>;
type Row = { member: VoiceMember; device?: Signed & { device_id: string }; signing: Record<string, Signed>; prekeys: Map<string, unknown>; consumed: Set<string>; fallback: boolean; inbox: unknown[] };
/** Deliberately small owner-unit directory, not a product service or generation dispatcher. */
export class OwnerUnitWire {
  private readonly rows = new Map<string, Row>();
  private readonly receipts = new Map<string, { input: string; response: unknown }>();
  readonly sent: { memberId: string; binding: VoiceBinding; request: VoiceCryptoRequest }[] = [];
  pause?: (entry: { memberId: string; request: VoiceCryptoRequest; response: unknown }) => Promise<void>;
  constructor(readonly snapshot: VoiceSnapshot) {
    for (const member of snapshot.members) this.rows.set(member.voiceUserId, { member, signing: {}, prekeys: new Map(), consumed: new Set(), fallback: false, inbox: [] });
  }
  port(memberId: string): VoiceOwnerTransport { return async ({ binding, request }) => {
    const own = [...this.rows.values()].find(row => row.member.memberId === memberId);
    if (!own || binding.callId !== this.snapshot.callId || binding.memberId !== memberId || binding.joinNonce !== own.member.joinNonce) throw new Error("Unit binding mismatch.");
    voiceCryptoSchema.parse(request);
    const receiptId = "requestId" in request ? request.requestId : undefined;
    const receiptKey = `${memberId}:${receiptId}`;
    const input = JSON.stringify({ binding, request });
    const previous = receiptId ? this.receipts.get(receiptKey) : undefined;
    if (previous) { if (previous.input !== input) throw new Error("Unit receipt conflict."); return previous.response; }
    this.sent.push({ memberId, binding: structuredClone(binding), request: structuredClone(request) });
    if (this.sent.length > 512) throw new Error("Unit work bound.");
    const response = this.process(own, request);
    if (receiptId) this.receipts.set(receiptKey, { input, response });
    await this.pause?.({ memberId, request, response });
    return response;
  }; }
  private process(own: Row, request: VoiceCryptoRequest): unknown {
    if (request.kind === "upload") {
      if (request.body.device_keys) {
        const device = signed.extend({ device_id: z.string() }).parse(request.body.device_keys);
        if (device.user_id !== own.member.voiceUserId || device.device_id !== own.member.voiceDeviceId) throw new Error("Unit upload mismatch."); own.device = device;
      }
      for (const [id, key] of Object.entries(object.parse(request.body.one_time_keys ?? {}))) if (!own.consumed.has(id)) own.prekeys.set(id, key);
      if (own.prekeys.size > VOICE_LIMITS.prekeys) throw new Error("Unit prekey bound.");
      own.fallback ||= Object.keys(object.parse(request.body.fallback_keys ?? {})).length > 0;
      return { one_time_key_counts: { signed_curve25519: own.prekeys.size } };
    }
    if (request.kind === "signing") { for (const name of ["master_key", "self_signing_key", "user_signing_key"]) { const key = signed.parse(request.body[name]); if (key.user_id !== own.member.voiceUserId) throw new Error("Unit signing mismatch."); own.signing[name] = key; } return {}; }
    if (request.kind === "query") {
      const device_keys: Record<string, unknown> = {}, master_keys: Record<string, unknown> = {}, self_signing_keys: Record<string, unknown> = {}, user_signing_keys: Record<string, unknown> = {};
      for (const [user, devices] of Object.entries(object.parse(request.body.device_keys))) {
        const target = this.rows.get(user); z.array(z.string()).max(1).parse(devices);
        device_keys[user] = target?.device ? { [target.member.voiceDeviceId]: target.device } : {};
        if (target?.signing.master_key) master_keys[user] = target.signing.master_key;
        if (target?.signing.self_signing_key) self_signing_keys[user] = target.signing.self_signing_key;
        if (target === own && target.signing.user_signing_key) user_signing_keys[user] = target.signing.user_signing_key;
      }
      return { device_keys, master_keys, self_signing_keys, user_signing_keys, failures: {} };
    }
    if (request.kind === "claim") {
      const one_time_keys: Record<string, unknown> = {};
      for (const [user, devices] of Object.entries(object.parse(request.body.one_time_keys))) for (const [device, algorithm] of Object.entries(object.parse(devices))) {
        const target = this.rows.get(user); if (!target || target.member.voiceDeviceId !== device || algorithm !== "signed_curve25519") throw new Error("Unit claim mismatch.");
        const next = target.prekeys.entries().next().value;
        if (next) { const [id, key] = next; target.prekeys.delete(id); target.consumed.add(id); one_time_keys[user] = { [device]: { [id]: key } }; }
      }
      return { one_time_keys, failures: {} };
    }
    if (request.kind === "signatures") {
      if (Object.keys(request.body).length !== 1) throw new Error("Unit signature fanout.");
      for (const [user, values] of Object.entries(request.body)) {
        const target = this.rows.get(user); if (!target) throw new Error("Unit signature target missing.");
        for (const [id, raw] of Object.entries(object.parse(values))) {
          const value = signed.parse(raw), key = id === target.member.voiceDeviceId ? target.device : Object.values(target.signing).find(item => Object.values(item.keys).includes(id));
          if (!key || value.user_id !== user || !value.signatures?.[own.member.voiceUserId]) throw new Error("Unit signature mismatch.");
          key.signatures = { ...key.signatures, [own.member.voiceUserId]: { ...key.signatures?.[own.member.voiceUserId], ...value.signatures[own.member.voiceUserId] } };
        }
      }
      return { failures: {} };
    }
    if (request.kind === "send" || request.kind === "retire") {
      const users = Object.entries(object.parse(request.body.messages));
      const devices = users.length === 1 ? Object.entries(object.parse(users[0][1])) : [];
      if (devices.length !== 1 || !voiceEventSchema(request.eventType)?.safeParse(devices[0][1]).success) throw new Error("Unit single-target event mismatch.");
      if (request.kind === "retire") return { nativeResponse: {}, disposition: { status: "processed-retired", enqueued: 0 } };
      const target = this.rows.get(users[0][0]); if (!target || target.member.voiceDeviceId !== devices[0][0] || target.inbox.length >= VOICE_LIMITS.mailbox) throw new Error("Unit destination mismatch.");
      target.inbox.push({ sender: own.member.voiceUserId, type: request.eventType, content: devices[0][1] });
      return { nativeResponse: {}, disposition: { status: "processed-current", enqueued: 1 } };
    }
    if (request.kind === "sync") return { cursor: "0", events: own.inbox.splice(0, VOICE_LIMITS.syncBatch), oneTimeKeys: { signed_curve25519: own.prekeys.size }, unusedFallbackKeys: own.fallback ? ["signed_curve25519"] : [] };
    if (request.kind === "ack") return {};
    throw new Error("Unsupported unit operation.");
  }
}

/** Public SDK peer used to produce genuine encrypted negative payloads; no owner private access. */
export class OwnerUnitPeer {
  private constructor(readonly machine: C.OlmMachine, readonly snapshot: VoiceSnapshot, private readonly port: VoiceOwnerTransport) {}
  static async create(snapshot: VoiceSnapshot, port: VoiceOwnerTransport): Promise<OwnerUnitPeer> {
    await C.initAsync();
    const machine = await C.OlmMachine.initialize(new C.UserId(snapshot.voiceUserId), new C.DeviceId(snapshot.voiceDeviceId), undefined, undefined, { debug() {}, info() {}, warn() {}, error() {} });
    const peer = new OwnerUnitPeer(machine, snapshot, port);
    machine.roomKeyRequestsEnabled = false; machine.roomKeyForwardingEnabled = false;
    try {
      await peer.flush();
      const bootstrap = await machine.bootstrapCrossSigning(false);
      if (bootstrap.uploadKeysRequest) await peer.out(bootstrap.uploadKeysRequest);
      await peer.wire({ kind: "signing", body: JSON.parse(bootstrap.uploadSigningKeysRequest.body) });
      await peer.out(bootstrap.uploadSignaturesRequest); return peer;
    } catch (error) { machine.close(); throw error; }
  }
  private wire(request: VoiceCryptoRequest): Promise<unknown> { return this.port({ binding: { callId: this.snapshot.callId, memberId: this.snapshot.memberId, joinNonce: this.snapshot.joinNonce, expectedGeneration: this.snapshot.generation }, request, signal: new AbortController().signal }); }
  async out(request: Native): Promise<void> {
    const kind = request instanceof C.KeysUploadRequest ? "upload" : request instanceof C.KeysQueryRequest ? "query" : request instanceof C.KeysClaimRequest ? "claim" : request instanceof C.SignatureUploadRequest ? "signatures" : request instanceof C.ToDeviceRequest ? "send" : undefined;
    if (!kind) throw new Error("Unsupported peer output.");
    const response = await this.wire(voiceCryptoSchema.parse({ kind, body: JSON.parse(request.body), ...(request.id ? { requestId: crypto.randomUUID(), nativeRequestId: request.id } : {}), ...(request instanceof C.ToDeviceRequest ? { eventType: request.event_type, nativeTxnId: request.txn_id } : {}) }));
    if (request.id) await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(request instanceof C.ToDeviceRequest ? z.object({ nativeResponse: object }).parse(response).nativeResponse : response));
  }
  async flush(): Promise<void> { for (let round = 0; round < 4; round++) { const output = await this.machine.outgoingRequests(); if (!output.length) return; for (const request of output) await this.out(request); } throw new Error("Unit peer flush bound."); }
  async receive(): Promise<void> { const batch = z.object({ events: z.array(z.unknown()), oneTimeKeys: z.record(z.string(), z.number()), unusedFallbackKeys: z.array(z.string()) }).parse(await this.wire({ kind: "sync" })); await this.machine.receiveSyncChanges(JSON.stringify(batch.events), new C.DeviceLists([], []), new Map(Object.entries(batch.oneTimeKeys)), new Set(batch.unusedFallbackKeys), new C.DecryptionSettings(C.TrustRequirement.CrossSigned)); await this.flush(); }
  async query(): Promise<void> { await this.out(this.machine.queryKeysForUsers(this.snapshot.members.map(member => new C.UserId(member.voiceUserId)))); }
  async encrypt(recipient: VoiceMember, payload: unknown): Promise<void> {
    const missing = await this.machine.getMissingSessions([new C.UserId(recipient.voiceUserId)]); if (missing) await this.out(missing);
    const device = await this.machine.getDevice(new C.UserId(recipient.voiceUserId), new C.DeviceId(recipient.voiceDeviceId)); if (!device?.isVerified()) throw new Error("Unit peer is not natively verified.");
    const encrypted = await device.encryptToDeviceEvent(VOICE_CONTROL_EVENT, payload, C.CollectStrategy.onlyTrustedDevices()), id = crypto.randomUUID();
    await this.out(new C.ToDeviceRequest(id, "m.room.encrypted", id, JSON.stringify({ messages: { [recipient.voiceUserId]: { [recipient.voiceDeviceId]: JSON.parse(encrypted) } } })));
  }
  close(): void { this.machine.close(); }
}
