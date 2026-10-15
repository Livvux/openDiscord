import { randomBytes, randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instanceAuditLog, session } from "@/db/schema";
import { dmResetState, resetDmIdentity } from "@/server/dm-reset";
import { matrixRoom, matrixUser, type DmDeviceAuth } from "@/lib/dm/contracts";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { appendDirectMessage, createDirectConversation, handleCryptoRequest, listDirectMessages, registerDmDevice, respondToDirectRequest } from "@/server/direct-messages";
import { testUsers } from "./helpers";

type Request = C.KeysUploadRequest | C.KeysQueryRequest | C.KeysClaimRequest | C.ToDeviceRequest | C.SignatureUploadRequest | C.RoomMessageRequest | C.KeysBackupRequest;
const users = testUsers();
const syncSchema = z.object({ cursor: z.string(), events: z.array(z.record(z.string(), z.unknown())), oneTimeKeys: z.record(z.string(), z.number()), unusedFallbackKeys: z.array(z.string()) });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
afterAll(() => users.cleanup());

/** Real SDK state machines use the production PostgreSQL transport, with no invented keys or local-trust override. */
class Endpoint {
  private constructor(readonly auth: DmDeviceAuth, readonly machine: C.OlmMachine) {}
  static async open(userId: string, restoredSecrets?: string) {
    const auth = { userId, sessionId: randomUUID(), deviceId: randomUUID(), secret: randomBytes(32).toString("hex") };
    await db.insert(session).values({ id: auth.sessionId, userId, token: randomUUID(), createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
    await registerDmDevice(userId, auth.sessionId, { id: auth.deviceId, secret: auth.secret, name: "Matrix integration" });
    const endpoint = new Endpoint(auth, await C.OlmMachine.initialize(new C.UserId(matrixUser(userId)), new C.DeviceId(auth.deviceId), undefined, undefined, logger));
    endpoint.machine.roomKeyForwardingEnabled = false;
    endpoint.machine.roomKeyRequestsEnabled = false;
    expect(endpoint.machine.roomKeyForwardingEnabled).toBe(false);
    expect(endpoint.machine.roomKeyRequestsEnabled).toBe(false);
    await endpoint.flush();
    if (restoredSecrets) await endpoint.machine.importSecretsBundle(C.SecretsBundle.from_json(restoredSecrets));
    const bootstrap = await endpoint.machine.bootstrapCrossSigning(false);
    if (bootstrap.uploadKeysRequest instanceof C.KeysUploadRequest) await endpoint.out(bootstrap.uploadKeysRequest);
    await handleCryptoRequest(auth, { kind: "signing", body: JSON.parse(bootstrap.uploadSigningKeysRequest.body) });
    await endpoint.out(bootstrap.uploadSignaturesRequest);
    return endpoint;
  }
  async out(request: Request) {
    const body: unknown = JSON.parse(request.body);
    let response: Record<string, unknown>;
    if (request.type === C.RequestType.KeysUpload) response = await handleCryptoRequest(this.auth, { kind: "upload", body });
    else if (request.type === C.RequestType.KeysQuery) response = await handleCryptoRequest(this.auth, { kind: "query", body });
    else if (request.type === C.RequestType.KeysClaim) response = await handleCryptoRequest(this.auth, { kind: "claim", requestId: request.id, body });
    else if (request.type === C.RequestType.SignatureUpload) response = await handleCryptoRequest(this.auth, { kind: "signatures", body });
    else if (request instanceof C.ToDeviceRequest) response = await handleCryptoRequest(this.auth, { kind: "send", requestId: request.txn_id, eventType: request.event_type, body });
    else throw new Error("Unexpected SDK request in fixture");
    if (request.id) await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(response));
  }
  async flush() { for (const request of await this.machine.outgoingRequests()) await this.out(request); }
  async query(ids: string[]) { await this.out(this.machine.queryKeysForUsers(ids.map((id) => new C.UserId(matrixUser(id))))); }
  async sync() {
    const result = syncSchema.parse(await handleCryptoRequest(this.auth, { kind: "sync" }));
    await this.machine.receiveSyncChanges(JSON.stringify(result.events), new C.DeviceLists([], []), new Map(Object.entries(result.oneTimeKeys)), new Set(result.unusedFallbackKeys));
    if (result.cursor !== "0") await handleCryptoRequest(this.auth, { kind: "ack", cursor: result.cursor });
    await this.flush();
  }
  verification(peer: Endpoint) {
    const requests = this.machine.getVerificationRequests(new C.UserId(matrixUser(peer.auth.userId)));
    if (requests.length !== 1) throw new Error(`Expected one verification, found ${requests.length}`);
    return requests[0];
  }
  sas(peer: Endpoint) {
    const sas = this.verification(peer).getVerification();
    if (!(sas instanceof C.Sas)) throw new Error("SAS was not established");
    return sas;
  }
}

async function verify(a: Endpoint, b: Endpoint) {
  const peer = await a.machine.getDevice(new C.UserId(matrixUser(b.auth.userId)), new C.DeviceId(b.auth.deviceId));
  expect(peer?.isVerified()).toBe(false);
  await a.out(peer!.requestVerification([C.VerificationMethod.SasV1])[1]);
  await b.sync();
  const accepted = b.verification(a).acceptWithMethods([C.VerificationMethod.SasV1]);
  expect(accepted).toBeDefined(); await b.out(accepted!);
  await a.sync();
  const started = await a.verification(b).startSas();
  expect(started).toBeDefined(); await a.out(started![1]);
  await b.sync();
  const sasAccept = b.sas(a).accept();
  if (sasAccept) await b.out(sasAccept);
  await a.sync(); await b.sync(); await a.sync();
  expect(a.sas(b).decimals()).toBeDefined();
  expect(Array.from(a.sas(b).decimals()!)).toEqual(Array.from(b.sas(a).decimals()!));
  for (const request of await a.sas(b).confirm()) await a.out(request);
  for (const request of await b.sas(a).confirm()) await b.out(request);
  await a.sync(); await b.sync(); await a.sync(); await b.sync();
  await a.query([a.auth.userId, b.auth.userId]); await b.query([a.auth.userId, b.auth.userId]);
  expect((await a.machine.getDevice(new C.UserId(matrixUser(b.auth.userId)), new C.DeviceId(b.auth.deviceId)))?.isVerified()).toBe(true);

}

describe("Matrix and PostgreSQL integration", () => {
  it("performs human-confirmed SAS and authenticates offline Megolm delivery end to end", async () => {
    await C.initAsync();
    const [alice, bob] = await Promise.all([users.create("SDK Alice"), users.create("SDK Bob")]);
    const { communityId } = await createCommunity(alice, "SDK integration");
    await acceptInvite(bob, await createInvite(alice, communityId, { expiresInHours: 24, maxUses: null }));
    const conversation = await createDirectConversation(alice, bob);
    await respondToDirectRequest(bob, conversation, "accepted");
    const a = await Endpoint.open(alice), b = await Endpoint.open(bob);
    try {
      await a.query([alice, bob]); await b.query([alice, bob]);
      await verify(a, b);
      // A verified peer can place native events inside an opaque voice envelope.
      // Scope fields are deliberately foreign to the DM flow; application dispatch discards all returns.
      const attackRoom = new C.RoomId(matrixRoom(randomUUID()));
      const attackSettings = new C.EncryptionSettings();
      attackSettings.sharingStrategy = C.CollectStrategy.onlyTrustedDevices();
      const shares = await a.machine.shareRoomKey(attackRoom, [new C.UserId(matrixUser(bob))], attackSettings);
      const share = shares[0];
      if (!share) throw new Error("Verified native room-key fixture missing");
      const body = JSON.parse(share.body) as { messages: Record<string, Record<string, unknown>> };
      const encryptedKey = body.messages[matrixUser(bob)]?.[b.auth.deviceId];
      if (!encryptedKey) throw new Error("Verified native envelope missing");
      const before = (await b.machine.roomKeyCounts()).total;
      const native = await b.machine.receiveSyncChanges(JSON.stringify([{
        sender: matrixUser(alice), type: "m.room.encrypted", content: encryptedKey,
        purpose: "opendiscord.voice", callId: "foreign-call",
      }]), new C.DeviceLists([], []), new Map([["signed_curve25519", 50]]), undefined, new C.DecryptionSettings(C.TrustRequirement.CrossSigned));
      expect(native.length).toBe(1);
      // Concrete counterexample: strict native trust plus gossip-off does not provide scope isolation.
      expect((await b.machine.roomKeyCounts()).total - before).toBe(1);
      for (let round = 0; round < 4; round++) {
        const pending = await b.machine.outgoingRequests();
        const unowned = pending.filter((request) => request instanceof C.ToDeviceRequest);
        expect(unowned.length).toBe(0);
        // No request from this rejected scope is submitted or marked sent.
      }
      const claim = await a.machine.getMissingSessions([new C.UserId(matrixUser(bob))]);
      if (claim) await a.out(claim);
      const room = new C.RoomId(matrixRoom(conversation));
      const settings = new C.EncryptionSettings(); settings.sharingStrategy = C.CollectStrategy.onlyTrustedDevices();
      for (const request of await a.machine.shareRoomKey(room, [new C.UserId(matrixUser(alice)), new C.UserId(matrixUser(bob))], settings)) await a.out(request);
      const transaction = randomUUID(), text = "Only the real recipient reads this fixture";
      const content = JSON.parse(await a.machine.encryptRoomEvent(room, "m.room.message", JSON.stringify({ msgtype: "m.text", body: text, conversation, transaction })));
      await appendDirectMessage(a.auth, conversation, { transactionId: transaction, content });
      const timeline = await listDirectMessages(bob, conversation);
      expect(JSON.stringify(timeline)).not.toContain(text);
      // Recipient processes its mailbox only after the message has been durably stored.
      await b.sync();
      const event = { type: "m.room.encrypted", event_id: `$${timeline.messages[0].id}`, origin_server_ts: new Date(timeline.messages[0].createdAt).getTime(), sender: matrixUser(alice), content };
      const decrypted = await b.machine.decryptRoomEvent(JSON.stringify(event), room, new C.DecryptionSettings(C.TrustRequirement.CrossSigned));
      expect(decrypted.shieldState(true).color).toBe(C.ShieldColor.None);
      expect(JSON.parse(decrypted.event).content.body).toBe(text);
      await expect(b.machine.decryptRoomEvent(JSON.stringify({ ...event, sender: matrixUser(bob), event_id: `$${randomUUID()}` }), room, new C.DecryptionSettings(C.TrustRequirement.CrossSigned))).rejects.toThrow();
      // The DM verification flow has no knowledge of the foreign voice wrapper.
      const verifiedPeer = await a.machine.getDevice(new C.UserId(matrixUser(bob)), new C.DeviceId(b.auth.deviceId));
      if (!verifiedPeer) throw new Error("Verified peer missing");
      const [dmFlow, dmStart] = verifiedPeer.requestVerification([C.VerificationMethod.SasV1]);
      await a.out(dmStart); await b.sync();
      const receivedFlow = b.machine.getVerificationRequest(new C.UserId(matrixUser(alice)), dmFlow.flowId);
      if (!receivedFlow) throw new Error("Native request fixture missing");
      const ready = receivedFlow.acceptWithMethods([C.VerificationMethod.SasV1]);
      if (!ready) throw new Error("Native ready fixture missing");
      const readyBody = JSON.parse(ready.body) as { messages: Record<string, Record<string, unknown>> };
      const readyContent = readyBody.messages[matrixUser(alice)]?.[a.auth.deviceId];
      const senderDevice = await b.machine.getDevice(new C.UserId(matrixUser(alice)), new C.DeviceId(a.auth.deviceId));
      if (!readyContent || !senderDevice) throw new Error("Native ready recipient fixture missing");
      expect(dmFlow.isReady()).toBe(false);
      const opaqueReady = JSON.parse(await senderDevice.encryptToDeviceEvent(ready.event_type, readyContent, C.CollectStrategy.onlyTrustedDevices())) as unknown;
      const rejectedVoice = await a.machine.receiveSyncChanges(JSON.stringify([{
        sender: matrixUser(bob), type: "m.room.encrypted", content: opaqueReady,
        purpose: "opendiscord.voice", callId: "unrelated-call", generation: 999,
      }]), new C.DeviceLists([], []), new Map([["signed_curve25519", 50]]), undefined, new C.DecryptionSettings(C.TrustRequirement.CrossSigned));
      expect(rejectedVoice.length).toBe(1);
      expect(rejectedVoice[0] instanceof C.DecryptedToDeviceEvent).toBe(true);
      // Architecture counterexample: native DM SAS state advanced before foreign-scope application rejection.
      expect(dmFlow.isReady()).toBe(true);
      expect(dmFlow.isDone()).toBe(false);
      for (let round = 0; round < 4; round++) {
        const pending = await a.machine.outgoingRequests();
        expect(pending.filter((request) => request instanceof C.ToDeviceRequest).length).toBe(0);
        // Reject the entire opaque batch; never submit/mark it through DM fallback.
      }
      const resetSession = randomUUID();
      await db.insert(session).values({ id: resetSession, token: randomUUID(), userId: bob, createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
      const reset = await dmResetState(bob, resetSession);
      await resetDmIdentity(bob, resetSession, { identity: reset.identity!, twoFactorEnabled: false });
      await expect(handleCryptoRequest(b.auth, { kind: "sync" })).rejects.toThrow();
      const replacement = await Endpoint.open(bob);
      try {
        await a.query([alice, bob]);
        expect((await a.machine.getIdentity(new C.UserId(matrixUser(bob))))?.isVerified()).toBe(false);
        expect((await a.machine.getDevice(new C.UserId(matrixUser(bob)), new C.DeviceId(replacement.auth.deviceId)))?.isVerified()).toBe(false);
      } finally { replacement.machine.close(); await db.delete(instanceAuditLog).where(eq(instanceAuditLog.targetId, bob)); }

    } finally { a.machine.close(); b.machine.close(); }
  }, 20_000);
  it("quarantines native same-account secret output generated before scope rejection", async () => {
    await C.initAsync();
    const user = await users.create("Native own-device probe");
    const source = await Endpoint.open(user);
    const recipient = await Endpoint.open(user, (await source.machine.exportSecretsBundle()).to_json());
    try {
      await source.query([user]); await recipient.query([user]);
      const ownDevice = await source.machine.getDevice(new C.UserId(matrixUser(user)), new C.DeviceId(recipient.auth.deviceId));
      if (!ownDevice) throw new Error("Own-device fixture missing");
      await source.out(await ownDevice.verify());
      await source.query([user]); await recipient.query([user]);
      expect((await source.machine.getDevice(new C.UserId(matrixUser(user)), new C.DeviceId(recipient.auth.deviceId)))?.isVerified()).toBe(true);
      const claim = await recipient.machine.getMissingSessions([new C.UserId(matrixUser(user))]);
      if (claim) await recipient.out(claim);
      const target = await recipient.machine.getDevice(new C.UserId(matrixUser(user)), new C.DeviceId(source.auth.deviceId));
      if (!target) throw new Error("Own secret target missing");
      const encrypted = JSON.parse(await target.encryptToDeviceEvent("m.secret.request", {
        action: "request", requesting_device_id: recipient.auth.deviceId,
        request_id: "fixture-voice-secret-request", name: "m.cross_signing.master",
        purpose: "opendiscord.voice", callId: "foreign-own-device-call",
      }, C.CollectStrategy.onlyTrustedDevices())) as unknown;
      const returned = await source.machine.receiveSyncChanges(JSON.stringify([{
        sender: matrixUser(user), type: "m.room.encrypted", content: encrypted, purpose: "opendiscord.voice",
      }]), new C.DeviceLists([], []), new Map([["signed_curve25519", 50]]), undefined, new C.DecryptionSettings(C.TrustRequirement.CrossSigned));
      expect(returned.length).toBe(1);
      expect(returned[0] instanceof C.DecryptedToDeviceEvent).toBe(true);
      let opaqueOutputs = 0;
      for (let round = 0; round < 4; round++) {
        const pending = await source.machine.outgoingRequests();
        opaqueOutputs += pending.filter((request) => request instanceof C.ToDeviceRequest && request.event_type === "m.room.encrypted").length;
        // The owner is detached: no out()/flush()/markRequestAsSent occurs for this unowned output.
      }
      expect(opaqueOutputs).toBeGreaterThan(0);
      // Reattach to the same native owner: pending output remains; detaching is not cancellation.
      const reattached = await source.machine.outgoingRequests();
      expect(reattached.filter((request) => request instanceof C.ToDeviceRequest && request.event_type === "m.room.encrypted").length).toBeGreaterThan(0);
      const mailbox = syncSchema.parse(await handleCryptoRequest(recipient.auth, { kind: "sync" }));
      expect(mailbox.events.length).toBe(0);
    } finally { source.machine.close(); recipient.machine.close(); }
  }, 20_000);

});
