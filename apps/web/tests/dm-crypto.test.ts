import { randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { describe, expect, it } from "vitest";
import { matrixRoom, matrixUser, plainMessageSchema } from "@/lib/dm/contracts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("pinned Matrix cryptographic primitives", () => {
  it("authenticates Megolm ciphertext while transport event ids require the application replay ledger", async () => {
    await C.initAsync();
    const user = randomUUID(), device = randomUUID(), conversation = randomUUID();
    const machine = await C.OlmMachine.initialize(new C.UserId(matrixUser(user)), new C.DeviceId(device), undefined, undefined, logger);
    try {
      const room = new C.RoomId(matrixRoom(conversation));
      await machine.shareRoomKey(room, [], new C.EncryptionSettings());
      const payload = plainMessageSchema.parse({ msgtype: "m.text", body: "Cryptographic fixture", conversation, transaction: randomUUID() });
      const content = JSON.parse(await machine.encryptRoomEvent(room, "m.room.message", JSON.stringify(payload)));
      expect(JSON.stringify(content)).not.toContain(payload.body);
      const event = { type: "m.room.encrypted", event_id: `$${randomUUID()}`, sender: matrixUser(user), origin_server_ts: Date.now(), content };
      const settings = new C.DecryptionSettings(C.TrustRequirement.Untrusted);
      const decoded = await machine.decryptRoomEvent(JSON.stringify(event), room, settings);
      expect(JSON.parse(decoded.event).content).toEqual(payload);
      // Megolm does not authenticate the server-assigned event id. The browser ledger pins the encrypted transaction instead.
      const replay = await machine.decryptRoomEvent(JSON.stringify({ ...event, event_id: `$${randomUUID()}` }), room, settings);
      expect(JSON.parse(replay.event).content.transaction).toBe(payload.transaction);
      const tampered = { ...content, ciphertext: `AAAA${String(content.ciphertext).slice(4)}` };
      await expect(machine.decryptRoomEvent(JSON.stringify({ ...event, event_id: `$${randomUUID()}`, content: tampered }), room, settings)).rejects.toThrow();
    } finally { machine.close(); }
  });
  it("recovers identity secrets and room keys only with intact ciphertext and the private recovery material", async () => {
    await C.initAsync();
    const user = new C.UserId(matrixUser(randomUUID()));
    const first = await C.OlmMachine.initialize(user, new C.DeviceId(randomUUID()), undefined, undefined, logger);
    const second = await C.OlmMachine.initialize(user, new C.DeviceId(randomUUID()), undefined, undefined, logger);
    try {
      // Explicit manual archive recovery must remain independent of automatic gossip.
      for (const machine of [first, second]) {
        machine.roomKeyForwardingEnabled = false;
        machine.roomKeyRequestsEnabled = false;
        expect(machine.roomKeyForwardingEnabled).toBe(false);
        expect(machine.roomKeyRequestsEnabled).toBe(false);
      }
      await first.bootstrapCrossSigning(false);
      const snapshot = { secrets: (await first.exportSecretsBundle()).to_json(), roomKeys: await first.exportRoomKeys(() => true) };
      const attachment = C.Attachment.encrypt(new TextEncoder().encode(JSON.stringify(snapshot)));
      const information = attachment.mediaEncryptionInfo!;
      const ciphertext = attachment.encryptedData;
      const altered = ciphertext.slice(); altered[0] ^= 1;
      expect(() => C.Attachment.decrypt(new C.EncryptedAttachment(altered, information))).toThrow();
      const other = C.Attachment.encrypt(new Uint8Array([1, 2, 3]));
      expect(() => C.Attachment.decrypt(new C.EncryptedAttachment(ciphertext, other.mediaEncryptionInfo!))).toThrow();
      const restored = JSON.parse(new TextDecoder().decode(C.Attachment.decrypt(new C.EncryptedAttachment(ciphertext, information))));
      await second.importSecretsBundle(C.SecretsBundle.from_json(restored.secrets));
      await second.importExportedRoomKeys(restored.roomKeys, () => {});
      expect((await second.exportSecretsBundle()).to_json()).toEqual(snapshot.secrets);
      attachment.free(); other.free();
    } finally { first.close(); second.close(); }
  });
});
