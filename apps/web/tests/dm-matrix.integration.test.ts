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
  static async open(userId: string, bootstrap = true) {
    const auth = { userId, sessionId: randomUUID(), deviceId: randomUUID(), secret: randomBytes(32).toString("hex") };
    await db.insert(session).values({ id: auth.sessionId, userId, token: randomUUID(), createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
    await registerDmDevice(userId, auth.sessionId, { id: auth.deviceId, secret: auth.secret, name: "Matrix integration" });
    const endpoint = new Endpoint(auth, await C.OlmMachine.initialize(new C.UserId(matrixUser(userId)), new C.DeviceId(auth.deviceId), undefined, undefined, logger));
    await endpoint.flush();
    if (bootstrap) await endpoint.bootstrap();
    return endpoint;
  }
  async bootstrap() {
    const requests = await this.machine.bootstrapCrossSigning(false);
    if (requests.uploadKeysRequest instanceof C.KeysUploadRequest) await this.out(requests.uploadKeysRequest);
    await handleCryptoRequest(this.auth, { kind: "signing", body: JSON.parse(requests.uploadSigningKeysRequest.body) });
    await this.out(requests.uploadSignaturesRequest);
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
      const peer = await a.machine.getDevice(new C.UserId(matrixUser(bob)), new C.DeviceId(b.auth.deviceId));
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
      await a.query([alice, bob]); await b.query([alice, bob]);
      expect((await a.machine.getDevice(new C.UserId(matrixUser(bob)), new C.DeviceId(b.auth.deviceId)))?.isVerified()).toBe(true);
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
  it("a browser that loses a concurrent first setup drops its own identity and stays an unverified device", async () => {
    await C.initAsync();
    const owner = await users.create("SDK Setup Race");
    const winner = await Endpoint.open(owner), loser = await Endpoint.open(owner, false);
    try {
      await expect(loser.bootstrap()).rejects.toThrow("Restore your identity");
      await loser.query([owner]);
      const [ours, theirs] = await Promise.all([loser, winner].map((e) => e.machine.getIdentity(new C.UserId(matrixUser(owner)))));
      expect(ours?.masterKey).toBe(theirs?.masterKey);
      expect(ours?.isVerified()).toBe(false);
      expect((await loser.machine.crossSigningStatus()).hasMaster).toBe(false);
    } finally { winner.machine.close(); loser.machine.close(); }
  });
});
