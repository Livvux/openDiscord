import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { community, dmDevice, dmMessage, dmSignature, user } from "@/db/schema";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { blockUser } from "@/server/blocks";
import { createDirectConversation, respondToDirectRequest, listDirectConversations, listDirectMessages, appendDirectMessage, registerDmDevice, handleCryptoRequest, revokeDmDevice, saveDmBackup, getDmBackup, reportDirectMessage, exportDirectData } from "@/server/direct-messages";
import { assertDmOrigin } from "@/server/dm-http";
import { testUsers } from "./helpers";

const users = testUsers();
let alice: string, bob: string, outsider: string, conversation: string;
const aDevice = randomUUID(), bDevice = randomUUID();
const aSecret = randomBytes(32).toString("hex"), bSecret = randomBytes(32).toString("hex");
const matrix = (id: string) => `@${id}:opendiscord.local`;
const authA = () => ({ userId: alice, deviceId: aDevice, secret: aSecret });
const authB = () => ({ userId: bob, deviceId: bDevice, secret: bSecret });
const publicKeys = (id: string, device: string) => ({ user_id: matrix(id), device_id: device, algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"], keys: { [`curve25519:${device}`]: "a".repeat(43), [`ed25519:${device}`]: "b".repeat(43) }, signatures: { [matrix(id)]: { [`ed25519:${device}`]: "c".repeat(86) } } });
const envelope = { algorithm: "m.megolm.v1.aes-sha2", sender_key: "a".repeat(43), device_id: aDevice, session_id: "b".repeat(43), ciphertext: "c".repeat(96) };
beforeAll(async () => {
  [alice, bob, outsider] = await Promise.all(["DM Alice", "DM Bob", "DM outsider"].map(users.create));
  const { communityId } = await createCommunity(alice, "DM community");
  const invite = await createInvite(alice, communityId, { expiresInHours: 24, maxUses: null });
  await acceptInvite(bob, invite);
});
afterAll(() => users.cleanup());

describe("private encrypted conversations", () => {
  it("requires a shared community and acceptance without exposing a global directory", async () => {
    await expect(createDirectConversation(alice, outsider)).rejects.toThrow("not found");
    conversation = await createDirectConversation(alice, bob);
    expect(await createDirectConversation(alice, bob)).toBe(conversation);
    await expect(respondToDirectRequest(alice, conversation, "accepted")).rejects.toThrow();
    await expect(respondToDirectRequest(outsider, conversation, "accepted")).rejects.toThrow("not found");
    expect(await listDirectConversations(outsider)).toEqual([]);
    await respondToDirectRequest(bob, conversation, "accepted");
  });
  it("binds immutable device keys to account and possession, and rejects IDOR", async () => {
    await registerDmDevice(alice, { id: aDevice, secret: aSecret, name: "Browser A" });
    await registerDmDevice(bob, { id: bDevice, secret: bSecret, name: "Browser B" });
    await expect(registerDmDevice(bob, { id: aDevice, secret: bSecret, name: "Spoof" })).rejects.toThrow();
    await expect(handleCryptoRequest({ ...authA(), secret: bSecret }, { kind: "sync" })).rejects.toThrow();
    await expect(handleCryptoRequest(authA(), { kind: "upload", body: { device_keys: publicKeys(bob, aDevice) } })).rejects.toThrow();
    await handleCryptoRequest(authA(), { kind: "upload", body: { device_keys: publicKeys(alice, aDevice) } });
    await handleCryptoRequest(authB(), { kind: "upload", body: { device_keys: publicKeys(bob, bDevice), one_time_keys: { "signed_curve25519:one": { key: "d".repeat(43), signatures: {} } } } });
    await expect(handleCryptoRequest(authA(), { kind: "query", body: { device_keys: { [matrix(outsider)]: [] } } })).rejects.toThrow("not found");
    await expect(handleCryptoRequest(authA(), { kind: "upload", body: { device_keys: { ...publicKeys(alice, aDevice), keys: {} } } })).rejects.toThrow();
  });
  it("atomically claims one-time keys and safely retries the same claim", async () => {
    const request = { kind: "claim", requestId: randomUUID(), body: { one_time_keys: { [matrix(bob)]: { [bDevice]: "signed_curve25519" } } } };
    const replies = await Promise.all(Array.from({ length: 4 }, () => handleCryptoRequest(authA(), request)));
    for (const reply of replies) expect(reply).toEqual(replies[0]);
    await handleCryptoRequest(authB(), { kind: "upload", body: { device_keys: publicKeys(bob, bDevice), one_time_keys: { "signed_curve25519:one": { key: "d".repeat(43), signatures: {} } } } });
    const next = await handleCryptoRequest(authA(), { ...request, requestId: randomUUID() });
    expect(JSON.stringify(next)).not.toContain("signed_curve25519:one");
  });
  it("separates fallback and one-time prekey IDs without resurrecting consumed keys", async () => {
    const oneTime = { key: "e".repeat(43), signatures: {} };
    const fallback = { key: "f".repeat(43), signatures: {}, fallback: true };
    const body = { one_time_keys: { "signed_curve25519:shared": oneTime }, fallback_keys: { "signed_curve25519:shared": fallback } };
    await handleCryptoRequest(authB(), { kind: "upload", body });
    const request = () => ({ kind: "claim", requestId: randomUUID(), body: { one_time_keys: { [matrix(bob)]: { [bDevice]: "signed_curve25519" } } } });
    expect(await handleCryptoRequest(authA(), request())).toEqual({ failures: {}, one_time_keys: { [matrix(bob)]: { [bDevice]: { "signed_curve25519:shared": oneTime } } } });
    expect((await handleCryptoRequest(authB(), { kind: "sync" })).unusedFallbackKeys).toEqual(["signed_curve25519"]);
    await handleCryptoRequest(authB(), { kind: "upload", body });
    expect(await handleCryptoRequest(authA(), request())).toEqual({ failures: {}, one_time_keys: { [matrix(bob)]: { [bDevice]: { "signed_curve25519:shared": fallback } } } });
    await expect(handleCryptoRequest(authB(), { kind: "upload", body: { one_time_keys: { "signed_curve25519:shared": fallback } } })).rejects.toThrow("immutable");
  });
  it("accepts ciphertext only, deduplicates sends and isolates timeline access", async () => {
    await expect(appendDirectMessage(authA(), conversation, { transactionId: randomUUID(), content: { body: "plaintext" } })).rejects.toThrow();
    const transactionId = randomUUID();
    const first = await appendDirectMessage(authA(), conversation, { transactionId, content: envelope });
    expect(await appendDirectMessage(authA(), conversation, { transactionId, content: envelope })).toEqual(first);
    await expect(appendDirectMessage(authA(), conversation, { transactionId, content: { ...envelope, ciphertext: "z".repeat(96) } })).rejects.toThrow();
    expect((await listDirectMessages(bob, conversation)).messages).toHaveLength(1);
    await expect(listDirectMessages(outsider, conversation)).rejects.toThrow("not found");
    expect((await db.select().from(dmMessage).where(eq(dmMessage.conversationId, conversation)))[0].content).toEqual(envelope);
  });
  it("mailbox retries are idempotent and explicit acknowledgments remove only consumed items", async () => {
    const request = { kind: "send", requestId: randomUUID(), eventType: "m.key.verification.request", body: { messages: { [matrix(bob)]: { [bDevice]: { from_device: aDevice, transaction_id: randomUUID(), methods: ["m.sas.v1"], timestamp: Date.now() } } } } };
    await handleCryptoRequest(authA(), request);
    await handleCryptoRequest(authA(), request);
    const sync = await handleCryptoRequest(authB(), { kind: "sync" }) as { cursor: string; events: unknown[] };
    expect(sync.events).toHaveLength(1);
    expect((await handleCryptoRequest(authB(), { kind: "sync" }) as typeof sync).events).toHaveLength(1);
    await handleCryptoRequest(authB(), { kind: "ack", cursor: sync.cursor });
    expect((await handleCryptoRequest(authB(), { kind: "sync" }) as typeof sync).events).toHaveLength(0);
  });
  it("isolates encrypted backups and explicit reports without exporting device secrets", async () => {
    const id = randomUUID();
    await saveDmBackup(authA(), { id, ciphertext: "a".repeat(128) });
    expect(await getDmBackup(alice, id)).toEqual({ ciphertext: "a".repeat(128) });
    await expect(getDmBackup(bob, id)).rejects.toThrow("not found");
    await expect(revokeDmDevice(bob, aDevice)).rejects.toThrow("not found");
    const message = (await listDirectMessages(bob, conversation)).messages[0];
    await expect(reportDirectMessage(outsider, { id: message.id, reason: "Not my conversation", excerpt: null })).rejects.toThrow();
    await reportDirectMessage(bob, { id: message.id, reason: "Recipient disclosure", excerpt: null });
    const exported = JSON.stringify(await exportDirectData(alice));
    expect(exported).not.toContain(aSecret);
    expect(exported).not.toContain("secretHash");
    expect(exported).toContain("encryptedBackups");
  });
  it("rejects cross-origin mutations, plaintext device payloads and transaction replay changes", async () => {
    expect(() => assertDmOrigin(new Request("https://local.invalid/api/dm", { method: "POST", headers: { origin: "https://foreign.invalid", "content-type": "application/json" } }))).toThrow();
    const request = { kind: "send", requestId: randomUUID(), eventType: "m.key.verification.done", body: { messages: { [matrix(bob)]: { [bDevice]: { transaction_id: randomUUID() } } } } };
    await handleCryptoRequest(authA(), request);
    await expect(handleCryptoRequest(authA(), { ...request, eventType: "m.key.verification.cancel" })).rejects.toThrow("cannot be reused");
    await expect(handleCryptoRequest(authA(), { ...request, requestId: randomUUID(), body: { messages: { [matrix(bob)]: { [bDevice]: { transaction_id: randomUUID(), body: "plaintext disguised as control" } } } } })).rejects.toThrow();
  });
  it("accepts native SAS accept envelopes without a redundant method and refuses other chosen methods", async () => {
    const content = { transaction_id: randomUUID(), commitment: "a".repeat(43), key_agreement_protocol: "curve25519-hkdf-sha256", hash: "sha256", message_authentication_code: "hkdf-hmac-sha256.v2", short_authentication_string: ["decimal"] };
    const send = (value: unknown) => ({ kind: "send", requestId: randomUUID(), eventType: "m.key.verification.accept", body: { messages: { [matrix(bob)]: { [bDevice]: value } } } });
    await handleCryptoRequest(authA(), send(content));
    await expect(handleCryptoRequest(authA(), send({ ...content, method: "m.qr_code.show.v1" }))).rejects.toThrow();
  });
  it("preserves the pinned SDK encrypted-message ID extension and bounds its shape", async () => {
    const messageId = randomUUID().replaceAll("-", "");
    const content = { algorithm: "m.olm.v1.curve25519-aes-sha2", sender_key: "a".repeat(43), "org.matrix.msgid": messageId, ciphertext: { ["b".repeat(43)]: { type: 0, body: "c".repeat(96) } } };
    const send = (value: unknown) => ({ kind: "send", requestId: randomUUID(), eventType: "m.room.encrypted", body: { messages: { [matrix(bob)]: { [bDevice]: value } } } });
    await handleCryptoRequest(authA(), send(content));
    expect(JSON.stringify((await handleCryptoRequest(authB(), { kind: "sync" })).events)).toContain(messageId);
    await expect(handleCryptoRequest(authA(), send({ ...content, "org.matrix.msgid": "x".repeat(200) }))).rejects.toThrow();
  });
  it("does not disclose unrelated accounts through a peer's cross-signatures", async () => {
    await db.insert(dmSignature).values([
      { signerId: outsider, targetId: bob, keyId: bDevice, signatures: { "ed25519:other-contact": "z".repeat(86) } },
      { signerId: alice, targetId: bob, keyId: bDevice, signatures: { "ed25519:known-contact": "y".repeat(86) } },
    ]);
    const response = await handleCryptoRequest(authA(), { kind: "query", body: { device_keys: { [matrix(bob)]: [] } } });
    expect(JSON.stringify(response)).not.toContain(matrix(outsider));
    expect(JSON.stringify(response)).toContain(matrix(bob));
    expect(JSON.stringify(response)).toContain(matrix(alice));
  });
  it("caps nested work before shared locks and refuses nonexistent signature targets", async () => {
    const huge = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [String(i), "signed_curve25519"]));
    await expect(handleCryptoRequest(authA(), { kind: "claim", requestId: randomUUID(), body: { one_time_keys: { [matrix(bob)]: huge } } })).rejects.toThrow("Too many target");
    await expect(handleCryptoRequest(authA(), { kind: "signatures", body: { [matrix(bob)]: { absent: { user_id: matrix(bob), keys: {}, signatures: { [matrix(alice)]: {} } } } } })).rejects.toThrow("does not exist");
  });
  it("requires accepted conversation consent for device traffic and concurrent requests do not exhaust the pool", async () => {
    const [sender, recipient] = await Promise.all([users.create("Consent sender"), users.create("Consent recipient")]);
    const { communityId } = await createCommunity(sender, "Consent community");
    await acceptInvite(recipient, await createInvite(sender, communityId, { expiresInHours: 24, maxUses: null }));
    const ids = await Promise.all(Array.from({ length: 10 }, () => createDirectConversation(sender, recipient)));
    expect(new Set(ids).size).toBe(1);
    const deviceId = randomUUID(), secret = randomBytes(32).toString("hex");
    await registerDmDevice(sender, { id: deviceId, secret, name: "Consent sender" });
    const auth = { userId: sender, deviceId, secret };
    const request = { kind: "send", requestId: randomUUID(), eventType: "m.key.verification.done", body: { messages: { [matrix(recipient)]: { "*": { transaction_id: randomUUID() } } } } };
    await expect(handleCryptoRequest(auth, request)).rejects.toThrow("not found");
    await respondToDirectRequest(recipient, ids[0], "rejected");
    await expect(handleCryptoRequest(auth, request)).rejects.toThrow("not found");
  });
  it("blocking stops delivery; revocation is terminal; deleting accounts cascades private stores", async () => {
    await blockUser(bob, alice);
    expect((await handleCryptoRequest(authB(), { kind: "sync" })).events).toEqual([]);
    await expect(appendDirectMessage(authA(), conversation, { transactionId: randomUUID(), content: envelope })).rejects.toThrow();
    await revokeDmDevice(alice, aDevice);
    await expect(handleCryptoRequest(authA(), { kind: "sync" })).rejects.toThrow();
    await expect(registerDmDevice(alice, { id: aDevice, secret: aSecret, name: "Resurrection" })).rejects.toThrow();
    await db.delete(community).where(eq(community.ownerId, alice));
    await db.delete(user).where(eq(user.id, alice));
    expect(await db.select().from(dmDevice).where(eq(dmDevice.userId, alice))).toEqual([]);
    expect(await db.select().from(dmMessage).where(eq(dmMessage.conversationId, conversation))).toEqual([]);
  });
});
