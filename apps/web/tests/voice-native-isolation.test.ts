import { randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { describe, expect, it } from "vitest";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
type JsonObject = Record<string, unknown>;
type Fixture = { machine: C.OlmMachine; user: C.UserId; device: C.DeviceId; upload: JsonObject };

async function fixture(): Promise<Fixture> {
  const user = new C.UserId(`@${randomUUID()}:opendiscord.invalid`);
  const device = new C.DeviceId(randomUUID());
  const machine = await C.OlmMachine.initialize(user, device, undefined, undefined, logger);
  machine.roomKeyForwardingEnabled = false;
  machine.roomKeyRequestsEnabled = false;
  expect(machine.roomKeyForwardingEnabled).toBe(false);
  expect(machine.roomKeyRequestsEnabled).toBe(false);
  const request = (await machine.outgoingRequests()).find((item) => item instanceof C.KeysUploadRequest);
  if (!(request instanceof C.KeysUploadRequest)) throw new Error("Fixture key upload missing");
  const upload = JSON.parse(request.body) as JsonObject;
  await machine.markRequestAsSent(request.id, request.type, JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }));
  return { machine, user, device, upload };
}

async function connect(sender: Fixture, recipient: Fixture) {
  for (const [source, target] of [[sender, recipient], [recipient, sender]]) {
    const request = source.machine.queryKeysForUsers([target.user]);
    await source.machine.markRequestAsSent(request.id, request.type, JSON.stringify({
      device_keys: { [target.user.toString()]: { [target.device.toString()]: target.upload.device_keys } },
      failures: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {},
    }));
  }
  const claim = await sender.machine.getMissingSessions([recipient.user]);
  if (!claim) throw new Error("Fixture claim missing");
  const keys = recipient.upload.one_time_keys as JsonObject;
  const first = Object.entries(keys)[0];
  if (!first) throw new Error("Fixture prekey missing");
  await sender.machine.markRequestAsSent(claim.id, claim.type, JSON.stringify({
    one_time_keys: { [recipient.user.toString()]: { [recipient.device.toString()]: { [first[0]]: first[1] } } }, failures: {},
  }));
}

async function inject(sender: Fixture, recipient: Fixture, type: string, content: JsonObject, trust: C.TrustRequirement, nativeEnvelope?: unknown) {
  const device = await sender.machine.getDevice(recipient.user, recipient.device);
  if (!device) throw new Error("Fixture device missing");
  const encrypted: unknown = nativeEnvelope ?? JSON.parse(await device.encryptToDeviceEvent(type, content, C.CollectStrategy.allDevices()));
  // Purpose and wrapper metadata are application assertions, not native dispatch boundaries.
  const processed = await recipient.machine.receiveSyncChanges(JSON.stringify([{
    sender: sender.user.toString(), type: "m.room.encrypted", content: encrypted,
    purpose: "opendiscord.voice", callId: "fixture-call",
  }]), new C.DeviceLists([], []), new Map([["signed_curve25519", 50]]), undefined, new C.DecryptionSettings(trust));
  const summary = processed.map((event) => event.constructor.name);
  const outgoing: { round: number; requestType: number; eventType: string | null }[] = [];
  for (let round = 0; round < 4; round++) {
    for (const request of await recipient.machine.outgoingRequests()) {
      const body = JSON.parse(request.body) as JsonObject;
      outgoing.push({ round, requestType: request.type, eventType: typeof body.event_type === "string" ? body.event_type : request instanceof C.ToDeviceRequest ? request.event_type : null });
      // Intentionally no network submission and no markRequestAsSent for unowned work.
    }
  }
  return { summary, outgoing };
}

describe("native shared-machine isolation prerequisite (characterization, not product acceptance)", () => {
  it.each([C.TrustRequirement.Untrusted, C.TrustRequirement.CrossSigned])("characterizes native room-key processing before application discard, trust=%s", async (trust) => {
    await C.initAsync();
    const sender = await fixture(), recipient = await fixture();
    try {
      await connect(sender, recipient);
      const room = new C.RoomId(`!${randomUUID()}:opendiscord.invalid`);
      const settings = new C.EncryptionSettings();
      settings.sharingStrategy = C.CollectStrategy.allDevices();
      const shares = await sender.machine.shareRoomKey(room, [recipient.user], settings);
      const share = shares[0];
      if (!share) throw new Error("Fixture room share missing");
      const body = JSON.parse(share.body) as { messages: Record<string, Record<string, unknown>> };
      const envelope = body.messages[recipient.user.toString()]?.[recipient.device.toString()];
      if (!envelope) throw new Error("Fixture room envelope missing");
      const before = (await recipient.machine.roomKeyCounts()).total;
      const result = await inject(sender, recipient, "m.room_key", {}, trust, envelope);
      const after = (await recipient.machine.roomKeyCounts()).total;
      // No raw plaintext/key material enters assertion output.
      expect(result.summary).toHaveLength(1);
      expect(result.outgoing.filter((request) => request.eventType === "m.room_key" || request.eventType === "m.forwarded_room_key" || request.eventType === "m.secret.send")).toHaveLength(0);
      expect(after - before).toBe(trust === C.TrustRequirement.Untrusted ? 1 : 0);
      const content = JSON.parse(await sender.machine.encryptRoomEvent(room, "m.room.message", JSON.stringify({ body: "fixture" }))) as unknown;
      const timeline = JSON.stringify({ sender: sender.user.toString(), type: "m.room.encrypted", event_id: "$fixture", origin_server_ts: 1, content });
      // An imported key must not bypass the actual DM strict native trust gate.
      let strictAccepted = false;
      try { await recipient.machine.decryptRoomEvent(timeline, room, new C.DecryptionSettings(C.TrustRequirement.CrossSigned)); strictAccepted = true; } catch { /* Native trust/key rejection is expected. */ }
      expect(strictAccepted).toBe(false);
    } finally { sender.machine.close(); recipient.machine.close(); }
  });
  it("characterizes an unsolicited forwarded room key without treating a wrapper as isolation", async () => {
    await C.initAsync();
    const sender = await fixture(), recipient = await fixture();
    try {
      await connect(sender, recipient);
      const room = new C.RoomId(`!${randomUUID()}:opendiscord.invalid`);
      await sender.machine.shareRoomKey(room, [], new C.EncryptionSettings());
      const exported = JSON.parse(await sender.machine.exportRoomKeys(() => true)) as JsonObject[];
      const key = exported[0];
      if (!key) throw new Error("Fixture room export missing");
      const before = (await recipient.machine.roomKeyCounts()).total;
      const result = await inject(sender, recipient, "m.forwarded_room_key", {
        ...key, sender_claimed_ed25519_key: (key.sender_claimed_keys as JsonObject).ed25519,
        forwarding_curve25519_key_chain: [], purpose: "opendiscord.voice",
      }, C.TrustRequirement.Untrusted);
      expect(result.summary).toHaveLength(1);
      expect(result.outgoing.filter((request) => ["m.room_key", "m.forwarded_room_key", "m.secret.send"].includes(request.eventType ?? ""))).toHaveLength(0);
      // Unsolicited forwarded keys should not become trusted DM history.
      expect((await recipient.machine.roomKeyCounts()).total - before).toBe(0);
    } finally { sender.machine.close(); recipient.machine.close(); }
  });

  it.each(["m.room_key_request", "m.secret.request", "m.secret.send", "m.key.verification.done"])("observes unsolicited encrypted %s without submitting native work", async (type) => {
    await C.initAsync();
    const sender = await fixture(), recipient = await fixture();
    try {
      await connect(sender, recipient);
      const before = (await recipient.machine.roomKeyCounts()).total;
      const peer = await recipient.machine.getDevice(sender.user, sender.device);
      expect(peer?.isVerified()).toBe(false);
      const content: JsonObject = type === "m.room_key_request"
        ? { action: "request", requesting_device_id: sender.device.toString(), request_id: "fixture-request", body: { algorithm: "m.megolm.v1.aes-sha2", room_id: "!fixture:opendiscord.invalid", sender_key: "fixture", session_id: "fixture" } }
        : type === "m.secret.request"
          ? { action: "request", requesting_device_id: sender.device.toString(), request_id: "fixture-request", name: "m.cross_signing.master" }
          : type === "m.secret.send" ? { request_id: "unsolicited-fixture", secret: "invalid-fixture" }
            : { transaction_id: "foreign-call-flow" };
      const result = await inject(sender, recipient, type, { ...content, purpose: "opendiscord.voice", scope: "another-call" }, C.TrustRequirement.Untrusted);
      expect(result.summary).toHaveLength(1);
      expect(result.outgoing.filter((request) => ["m.room_key", "m.forwarded_room_key", "m.secret.send"].includes(request.eventType ?? ""))).toHaveLength(0);
      expect((await recipient.machine.roomKeyCounts()).total - before).toBe(0);
      expect((await recipient.machine.getDevice(sender.user, sender.device))?.isVerified()).toBe(false);
      expect(recipient.machine.getVerification(sender.user, "foreign-call-flow")).toBeUndefined();
    } finally { sender.machine.close(); recipient.machine.close(); }
  });

});
