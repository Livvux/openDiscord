// Ciphertext-only DM attachments; the storage round trip needs ATTACHMENT_DIR or R2_* (skipped otherwise).
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attachment, dmConversation, session } from "@/db/schema";
import { DM_MAX_ATTACHMENT_BYTES } from "@/lib/dm/contracts";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { appendDirectMessage, createDirectConversation, exportDirectData, handleCryptoRequest, registerDmDevice, respondToDirectRequest } from "@/server/direct-messages";
import { readDmAttachment, uploadDmAttachment } from "@/server/dm-attachments";
import { mediaEnabled, sweepAttachments } from "@/server/media";
import { testUsers } from "./helpers";

const users = testUsers();
const matrix = (id: string) => `@${id}:opendiscord.local`;
let alice: string, bob: string, outsider: string, conversation: string;
const aDevice = randomUUID(), aSession = randomUUID(), aSecret = randomBytes(32).toString("hex");
const authA = () => ({ userId: alice, sessionId: aSession, deviceId: aDevice, secret: aSecret });
const envelope = () => ({ algorithm: "m.megolm.v1.aes-sha2", sender_key: "a".repeat(43), device_id: aDevice, session_id: "b".repeat(43), ciphertext: randomBytes(48).toString("base64") });
const upload = (who: string, bytes: Uint8Array, id = conversation, length = bytes.byteLength) => uploadDmAttachment(who, id, length, async () => bytes);

beforeAll(async () => {
  [alice, bob, outsider] = await Promise.all(["Attach Alice", "Attach Bob", "Attach outsider"].map(users.create));
  await db.insert(session).values({ userId: alice, id: aSession, token: randomUUID(), createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
  const { communityId } = await createCommunity(alice, "Attachment community");
  await acceptInvite(bob, await createInvite(alice, communityId, { expiresInHours: 24, maxUses: null }));
  conversation = await createDirectConversation(alice, bob);
  await respondToDirectRequest(bob, conversation, "accepted");
  await registerDmDevice(alice, aSession, { id: aDevice, secret: aSecret, name: "Browser A" });
  await handleCryptoRequest(authA(), { kind: "upload", body: { device_keys: { user_id: matrix(alice), device_id: aDevice, algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"], keys: { [`curve25519:${aDevice}`]: "a".repeat(43), [`ed25519:${aDevice}`]: "b".repeat(43) }, signatures: {} } } });
});
afterAll(() => users.cleanup());

describe.skipIf(!mediaEnabled)("end-to-end encrypted DM attachments", () => {
  it("stores ciphertext opaquely and serves it only to conversation members after it is sent", async () => {
    const ciphertext = randomBytes(2048);
    const { id, size } = await upload(alice, ciphertext);
    expect(size).toBe(2048);
    const [row] = await db.select().from(attachment).where(eq(attachment.id, id));
    // No name, type or dimensions outside the ciphertext.
    expect(row).toMatchObject({ filename: null, contentType: "application/octet-stream", width: 0, height: 0, channelId: null, messageId: null, dmMessageId: null });
    // Unsent uploads are not readable, even by the uploader's peer.
    await expect(readDmAttachment(bob, id)).rejects.toThrow("not found");
    const sent = await appendDirectMessage(authA(), conversation, { transactionId: randomUUID(), content: envelope(), attachments: [id] });
    const response = await readDmAttachment(bob, id);
    expect(Buffer.from(await response.arrayBuffer()).equals(ciphertext)).toBe(true);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    await expect(readDmAttachment(outsider, id)).rejects.toThrow("not found");
    // A linked upload cannot be attached to a second message.
    await expect(appendDirectMessage(authA(), conversation, { transactionId: randomUUID(), content: envelope(), attachments: [id] })).rejects.toThrow("no longer available");
    const exported = await exportDirectData(alice);
    expect(exported.encryptedAttachments).toContainEqual(expect.objectContaining({ id, messageId: sent.id, size: 2048, url: `/api/dm/attachments/${id}` }));
    expect((await exportDirectData(bob)).encryptedAttachments.map((a) => a.id)).toContain(id);
  });

  it("refuses non-members, oversized bodies and attaching someone else's upload", async () => {
    await expect(upload(outsider, randomBytes(16))).rejects.toThrow("not found");
    await expect(upload(alice, new Uint8Array(0))).rejects.toThrow();
    await expect(upload(alice, randomBytes(16), conversation, DM_MAX_ATTACHMENT_BYTES + 1)).rejects.toThrow("at most");
    const { id } = await upload(bob, randomBytes(16));
    await expect(appendDirectMessage(authA(), conversation, { transactionId: randomUUID(), content: envelope(), attachments: [id] })).rejects.toThrow("no longer available");
    await expect(appendDirectMessage(authA(), conversation, { transactionId: randomUUID(), content: envelope(), attachments: Array.from({ length: 5 }, () => randomUUID()) })).rejects.toThrow();
  });

  it("removes stored ciphertext when its message goes with the conversation", async () => {
    const { id } = await upload(alice, randomBytes(64));
    await appendDirectMessage(authA(), conversation, { transactionId: randomUUID(), content: envelope(), attachments: [id] });
    // Linked DM ciphertext is not swept while its message exists.
    await sweepAttachments();
    expect(await db.select({ id: attachment.id }).from(attachment).where(eq(attachment.id, id))).toHaveLength(1);
    await db.delete(dmConversation).where(eq(dmConversation.id, conversation));
    await sweepAttachments();
    expect(await db.select({ id: attachment.id }).from(attachment).where(eq(attachment.id, id))).toEqual([]);
    await expect(readDmAttachment(alice, id)).rejects.toThrow("not found");
  });
});
