import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { z } from "zod";
import { CONTROL, controlSchema, envelopeSchema, same, sasTypes, syncSchema, type Binding, type Control, type WireRequest } from "./voice-three-contracts";

type Request = Awaited<ReturnType<C.OlmMachine["outgoingRequests"]>>[number];
type Verification = { request: C.VerificationRequest; sas?: C.Sas; peer: Binding };
const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Browser-local disposable SDK owner. Transport receives serialized native requests only. */
export class BrowserOlm {
  private readonly admitted = new Set<string>();
  private readonly flows = new Map<string, Verification>();
  private closed = false;
  verifiedControls = 0;
  private constructor(readonly binding: Binding, readonly peers: readonly Binding[], private readonly machine: C.OlmMachine, private readonly wire: (input: WireRequest) => Promise<unknown>, private readonly receive: (value: Control) => Promise<void>) {}
  static async open(binding: Binding, peers: readonly Binding[], wire: (input: WireRequest) => Promise<unknown>, receive: (value: Control) => Promise<void>): Promise<BrowserOlm> {
    await C.initAsync();
    const machine = await C.OlmMachine.initialize(new C.UserId(binding.user), new C.DeviceId(binding.device), undefined, undefined, logger);
    const owner = new BrowserOlm(binding, peers, machine, wire, receive);
    machine.roomKeyRequestsEnabled = false; machine.roomKeyForwardingEnabled = false;
    try {
      await owner.flush();
      const bootstrap = await machine.bootstrapCrossSigning(false);
      if (bootstrap.uploadKeysRequest) await owner.out(bootstrap.uploadKeysRequest);
      await wire({ kind: "signing", body: bootstrap.uploadSigningKeysRequest.body });
      await owner.out(bootstrap.uploadSignaturesRequest);
      await owner.query([binding]);
      return owner;
    } catch (error) { owner.close(); throw error; }
  }
  fingerprint(): string { return this.machine.identityKeys.ed25519.toBase64(); }
  peer(member: string): Binding {
    const peer = this.peers.find((value) => value.member === member);
    if (!peer) throw new Error("Unknown proof member.");
    return peer;
  }
  private async device(peer: Binding) {
    const device = await this.machine.getDevice(new C.UserId(peer.user), new C.DeviceId(peer.device));
    if (!device) throw new Error("Missing native browser device.");
    return device;
  }
  async query(peers: readonly Binding[] = this.peers): Promise<void> { await this.out(this.machine.queryKeysForUsers(peers.map((peer) => new C.UserId(peer.user)))); }
  private async out(request: Request): Promise<void> {
    if (this.closed) throw new Error("Closed native owner.");
    let kind: WireRequest["kind"];
    if (request instanceof C.KeysUploadRequest) kind = "upload";
    else if (request instanceof C.KeysQueryRequest) kind = "query";
    else if (request instanceof C.KeysClaimRequest) kind = "claim";
    else if (request instanceof C.SignatureUploadRequest) kind = "signatures";
    else if (request instanceof C.ToDeviceRequest) kind = "send";
    else throw new Error("Unsupported native browser output.");
    const response = await this.wire({ kind, id: request.id, body: request.body, ...(request instanceof C.ToDeviceRequest ? { event: request.event_type } : {}) });
    if (request.id) await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(response));
  }
  async flush(): Promise<void> {
    for (let round = 0; round < 8; round++) {
      const requests = await this.machine.outgoingRequests();
      if (!requests.length) return;
      for (const request of requests) await this.out(request);
    }
    throw new Error("Native queue bound.");
  }
  async sync(): Promise<void> {
    const batch = syncSchema.parse(await this.wire({ kind: "sync", body: "{}" }));
    const events = await this.machine.receiveSyncChanges(JSON.stringify(batch.events), new C.DeviceLists([], []), new Map([["signed_curve25519", batch.count]]), new Set(batch.fallback ? ["signed_curve25519"] : []), new C.DecryptionSettings(C.TrustRequirement.CrossSigned));
    for (const item of events) {
      if (item instanceof C.PlainTextToDeviceEvent) {
        const event = envelopeSchema.parse(JSON.parse(item.rawEvent));
        const peer = this.peers.find((value) => value.user === event.sender);
        if (!peer || !sasTypes.has(event.type)) throw new Error("Unexpected native plaintext event.");
        const flow = z.string().min(1).max(256).parse(event.content.transaction_id);
        const key = `${peer.member}:${flow}`;
        if (event.type === "m.key.verification.request") {
          const request = this.machine.getVerificationRequest(new C.UserId(peer.user), flow);
          if (!request || this.flows.size >= 8) throw new Error("Missing native request.");
          this.flows.set(key, { peer, request });
        } else if (!this.flows.has(key)) throw new Error("Unknown native flow.");
      } else if (item instanceof C.DecryptedToDeviceEvent) {
        const event = envelopeSchema.parse(JSON.parse(item.rawEvent));
        if (event.type !== CONTROL || !item.encryptionInfo.isSenderVerified()) throw new Error("Unverified control.");
        const control = controlSchema.parse(event.content), peer = this.peers.find((value) => same(value, control.sender));
        if (!peer || !this.admitted.has(peer.member) || !same(control.recipient, this.binding) || event.sender !== peer.user || item.encryptionInfo.sender.toString() !== peer.user || item.encryptionInfo.senderDevice?.toString() !== peer.device) throw new Error("Native control binding.");
        this.verifiedControls++;
        await this.receive(control);
      } else throw new Error("Unsupported native processed event.");
    }
    await this.flush();
  }
  private verification(member: string, flow: string): Verification {
    const value = this.flows.get(`${member}:${flow}`);
    if (!value) throw new Error("Unknown verification handle.");
    return value;
  }
  async request(member: string): Promise<string> {
    const peer = this.peer(member);
    await this.query([this.binding, peer]);
    const [request, output] = (await this.device(peer)).requestVerification([C.VerificationMethod.SasV1]);
    this.flows.set(`${member}:${request.flowId}`, { peer, request });
    await this.out(output); return request.flowId;
  }
  async verifyStep(member: string, flow: string, step: "accept" | "start" | "accept-sas" | "confirm"): Promise<void> {
    const handle = this.verification(member, flow);
    if (step === "accept") {
      const output = handle.request.acceptWithMethods([C.VerificationMethod.SasV1]);
      if (!output) throw new Error("SAS acceptance missing.");
      await this.out(output);
    } else if (step === "start") {
      const started = await handle.request.startSas();
      if (!started) throw new Error("SAS start missing.");
      handle.sas = started[0]; await this.out(started[1]);
    } else if (step === "accept-sas") {
      const sas = handle.request.getVerification();
      if (!(sas instanceof C.Sas)) throw new Error("Native SAS missing.");
      handle.sas = sas;
      const output = sas.accept(); if (output) await this.out(output);
    } else {
      if (!handle.sas) throw new Error("No SAS confirmation handle.");
      for (const output of await handle.sas.confirm()) await this.out(output);
    }
  }
  sas(member: string, flow: string): { decimals: number[] | null; done: boolean } {
    const { request, sas, peer } = this.verification(member, flow);
    if (!sas || sas.flowId !== flow || sas.userId.toString() !== this.binding.user || sas.deviceId.toString() !== this.binding.device || sas.otherUserId.toString() !== peer.user || sas.otherDeviceId.toString() !== peer.device) throw new Error("Native SAS binding.");
    const decimals = sas.decimals();
    return { decimals: decimals ? Array.from(decimals) : null, done: request.isDone() && sas.isDone() };
  }
  async trusted(member: string): Promise<boolean> { return (await this.device(this.peer(member))).isVerified(); }
  async admit(member: string): Promise<void> {
    if (!await this.trusted(member)) throw new Error("Fresh native SAS required.");
    const peer = this.peer(member);
    await this.wire({ kind: "admit", body: JSON.stringify({ user: peer.user, device: peer.device }) });
    this.admitted.add(member);
  }
  async send(control: Control): Promise<void> {
    const value = controlSchema.parse(control), peer = this.peer(value.recipient.member);
    if (!same(value.sender, this.binding) || !same(peer, value.recipient) || !this.admitted.has(peer.member)) throw new Error("Explicit admission required.");
    const device = await this.device(peer);
    if (!device.isVerified()) throw new Error("Fresh native SAS required.");
    const missing = await this.machine.getMissingSessions([new C.UserId(peer.user)]);
    if (missing) await this.out(missing);
    const encrypted = await device.encryptToDeviceEvent(CONTROL, value, C.CollectStrategy.onlyTrustedDevices());
    const id = crypto.randomUUID();
    await this.out(new C.ToDeviceRequest(id, "m.room.encrypted", id, JSON.stringify({ messages: { [peer.user]: { [peer.device]: JSON.parse(encrypted) } } })));
  }
  close(): void { if (this.closed) return; this.closed = true; this.admitted.clear(); this.flows.clear(); this.machine.close(); }
}
