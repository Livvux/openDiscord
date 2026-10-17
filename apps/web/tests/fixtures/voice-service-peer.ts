import { createHash, randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { z } from "zod";
import type { VoiceCryptoRequest, VoiceMember, VoiceSnapshot } from "../../src/lib/voice/contracts";
import type { VoiceOwnerTransport } from "../../src/lib/voice/crypto-owner";
import { VOICE_CONTROL_EVENT } from "../../src/lib/voice/owner-control";

type NativeRequest = Awaited<ReturnType<C.OlmMachine["outgoingRequests"]>>[number];
type SyncChanges = Awaited<ReturnType<C.OlmMachine["receiveSyncChanges"]>>;
const syncResult = z.object({ cursor: z.string(), events: z.array(z.unknown()), oneTimeKeys: z.record(z.string(), z.number()), unusedFallbackKeys: z.array(z.string()) });
const deviceResult = z.object({ nativeResponse: z.record(z.string(), z.unknown()) });
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Independent memory-only public SDK peer. The caller supplies the actual service transport. */
export class PublicServicePeer {
  private readonly abort = new AbortController();
  private constructor(readonly machine: C.OlmMachine, private current: VoiceSnapshot, private readonly transport: VoiceOwnerTransport) {}

  static async open({ snapshot, transport }: { snapshot: VoiceSnapshot; transport: VoiceOwnerTransport }): Promise<PublicServicePeer> {
    await C.initAsync();
    const machine = await C.OlmMachine.initialize(new C.UserId(snapshot.voiceUserId), new C.DeviceId(snapshot.voiceDeviceId), undefined, undefined, silent);
    machine.roomKeyRequestsEnabled = false;
    machine.roomKeyForwardingEnabled = false;
    const peer = new PublicServicePeer(machine, structuredClone(snapshot), transport);
    try {
      await peer.flush();
      const bootstrap = await machine.bootstrapCrossSigning(false);
      if (bootstrap.uploadKeysRequest) await peer.out(bootstrap.uploadKeysRequest);
      await peer.wire({ kind: "signing", body: JSON.parse(bootstrap.uploadSigningKeysRequest.body) });
      await peer.out(bootstrap.uploadSignaturesRequest);
      return peer;
    } catch (error) { peer.close(); throw error; }
  }

  static create(snapshot: VoiceSnapshot, transport: VoiceOwnerTransport): Promise<PublicServicePeer> {
    return PublicServicePeer.open({ snapshot, transport });
  }

  get snapshot(): VoiceSnapshot { return structuredClone(this.current); }

  /** Only pass snapshots returned by a real heartbeat or membership operation. */
  updateSnapshot(snapshot: VoiceSnapshot): void { this.current = structuredClone(snapshot); }

  private wire(request: VoiceCryptoRequest): Promise<unknown> {
    const s = this.current;
    return this.transport({ binding: { callId: s.callId, memberId: s.memberId, joinNonce: s.joinNonce, expectedGeneration: s.generation }, request, signal: this.abort.signal });
  }

  async out(request: NativeRequest, operation: "send" | "retire" = "send"): Promise<unknown> {
    const body: Record<string, unknown> = JSON.parse(request.body);
    const requestId = createHash("sha256").update(JSON.stringify([this.current.generation, operation, request.type, request.id, request.body, request instanceof C.ToDeviceRequest ? [request.event_type, request.txn_id] : null])).digest("hex");
    let input: VoiceCryptoRequest;
    if (request instanceof C.ToDeviceRequest) {
      if (!request.id || !request.txn_id) throw new Error("Public service peer requires native to-device IDs.");
      input = { kind: operation, body, requestId, nativeRequestId: request.id, nativeTxnId: request.txn_id, eventType: request.event_type };
    } else {
      if (operation === "retire") throw new Error("Only native to-device output can retire.");
      const ids = request.id ? { requestId, nativeRequestId: request.id } : {};
      if (request instanceof C.KeysUploadRequest) input = { kind: "upload", body, ...ids };
      else if (request instanceof C.KeysQueryRequest) input = { kind: "query", body, ...ids };
      else if (request instanceof C.KeysClaimRequest) {
        if (!request.id) throw new Error("Public service peer requires a native claim ID.");
        input = { kind: "claim", body, requestId, nativeRequestId: request.id };
      } else if (request instanceof C.SignatureUploadRequest) input = { kind: "signatures", body, ...ids };
      else throw new Error("Unsupported public native voice request.");
    }
    const response = await this.wire(input);
    if (request.id) {
      const nativeResponse = request instanceof C.ToDeviceRequest ? deviceResult.parse(response).nativeResponse : response;
      await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(nativeResponse));
    }
    return response;
  }

  async flush(): Promise<void> {
    for (let round = 0; round < 4; round++) {
      const requests = await this.machine.outgoingRequests();
      if (!requests.length) return;
      for (const request of requests) await this.out(request);
    }
    throw new Error("Public service peer flush bound exceeded.");
  }

  async query(members: readonly VoiceMember[] = this.current.members): Promise<void> {
    await this.out(this.machine.queryKeysForUsers(members.map(member => new C.UserId(member.voiceUserId))));
  }

  async claim(member: VoiceMember): Promise<void> {
    const request = await this.machine.getMissingSessions([new C.UserId(member.voiceUserId)]);
    if (request) await this.out(request);
  }

  /** Consume the real service batch, acknowledge its cursor, then flush genuine SDK output. */
  async sync(): Promise<SyncChanges> {
    const batch = syncResult.parse(await this.wire({ kind: "sync" }));
    const changes = await this.machine.receiveSyncChanges(JSON.stringify(batch.events), new C.DeviceLists([], []), new Map(Object.entries(batch.oneTimeKeys)), new Set(batch.unusedFallbackKeys));
    if (batch.cursor !== "0") await this.wire({ kind: "ack", cursor: batch.cursor });
    await this.flush();
    return changes;
  }

  receive(): Promise<SyncChanges> { return this.sync(); }

  verification(member: VoiceMember): C.VerificationRequest {
    const known = this.machine.getVerificationRequests(new C.UserId(member.voiceUserId)).filter(flow => !flow.isCancelled());
    const active = known.filter(flow => !flow.isDone());
    const flows = active.length ? active : known;
    if (flows.length !== 1) throw new Error("Expected one public native voice verification flow.");
    return flows[0];
  }

  sas(member: VoiceMember): C.Sas {
    const sas = this.verification(member).getVerification();
    if (!(sas instanceof C.Sas)) throw new Error("Public native voice SAS is not established.");
    return sas;
  }

  /** Payload context deliberately belongs to the test; encryption and trust remain native. */
  async encrypt(recipient: VoiceMember, payload: unknown): Promise<unknown> {
    const device = await this.machine.getDevice(new C.UserId(recipient.voiceUserId), new C.DeviceId(recipient.voiceDeviceId));
    if (!device?.isVerified()) throw new Error("Public service peer recipient is not natively verified.");
    await this.claim(recipient);
    const encrypted = await device.encryptToDeviceEvent(VOICE_CONTROL_EVENT, payload, C.CollectStrategy.onlyTrustedDevices());
    const id = randomUUID();
    return this.out(new C.ToDeviceRequest(id, "m.room.encrypted", id, JSON.stringify({ messages: { [recipient.voiceUserId]: { [recipient.voiceDeviceId]: JSON.parse(encrypted) } } })));
  }

  close(): void { this.abort.abort(); this.machine.close(); }
}
