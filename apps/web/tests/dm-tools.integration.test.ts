import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { dmConversation, dmDevice, dmMessage, session } from "@/db/schema";
import { appendDirectMessage, listDirectConversations, listDirectMessages, publishDirectTyping, canReceiveDirectTyping } from "@/server/direct-messages";
import { blockUser } from "@/server/blocks";
import { testUsers } from "./helpers";

const users = testUsers();
let alice: string, bob: string, outsider: string, conversation: string, target: string;
const secret = "a".repeat(64), deviceA = randomUUID(), deviceB = randomUUID(), sessionA = randomUUID(), sessionB = randomUUID();
const auth = (who: "alice" | "bob") => ({ userId: who === "alice" ? alice : bob, sessionId: who === "alice" ? sessionA : sessionB, deviceId: who === "alice" ? deviceA : deviceB, secret });
const content = (device: string) => ({ algorithm: "m.megolm.v1.aes-sha2", device_id: device, sender_key: "a".repeat(43), session_id: "b".repeat(43), ciphertext: "c".repeat(96) });
const input = (who: "alice" | "bob", kind: "message" | "edit" | "delete" | "reaction" = "message", targetId?: string) => ({ transactionId: randomUUID(), content: content(who === "alice" ? deviceA : deviceB), kind, ...(targetId ? { targetId } : {}) });
beforeAll(async () => {
  [alice, bob, outsider] = await Promise.all(["Tools Alice", "Tools Bob", "Tools outsider"].map(users.create));
  for (const [userId, deviceId, sessionId] of [[alice, deviceA, sessionA], [bob, deviceB, sessionB]]) {
    await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date() });
    await db.insert(dmDevice).values({ id: deviceId, userId, name: "Tools fixture", secretHash: createHash("sha256").update(secret).digest("hex"), keys: { keys: { [`curve25519:${deviceId}`]: "a".repeat(43) } } });
  }
  const [firstId, secondId] = [alice, bob].sort();
  const [row] = await db.insert(dmConversation).values({ firstId, secondId, status: "accepted", requestedBy: alice }).returning();
  conversation = row.id;
});
afterAll(() => users.cleanup());

describe("private message tools authorization and retention", () => {
  it("rejects outsider access and someone else's edits/deletes, while allowing encrypted reactions", async () => {
    target = (await appendDirectMessage(auth("alice"), conversation, input("alice"))).id;
    await expect(listDirectMessages(outsider, conversation)).rejects.toThrow();
    await expect(appendDirectMessage(auth("bob"), conversation, input("bob", "edit", target))).rejects.toThrow("author");
    await expect(appendDirectMessage(auth("bob"), conversation, input("bob", "delete", target))).rejects.toThrow("author");
    await appendDirectMessage(auth("bob"), conversation, input("bob", "reaction", target));
    expect((await listDirectConversations(alice))[0].unread).toBe(0);
  });
  it("binds updates to an existing message in the same conversation", async () => {
    await expect(appendDirectMessage(auth("alice"), conversation, input("alice", "edit", randomUUID()))).rejects.toThrow("not found");
    const edit = input("alice", "edit", target);
    await appendDirectMessage(auth("alice"), conversation, edit);
    await expect(appendDirectMessage(auth("alice"), conversation, { ...edit, kind: "reaction" })).rejects.toThrow("reused");
  });
  it("erases original/edit ciphertext and leaves terminal metadata tombstones", async () => {
    // A separate window avoids testing the existing send-rate limiter instead of deletion.
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await appendDirectMessage(auth("alice"), conversation, input("alice", "delete", target));
    const rows = await db.select().from(dmMessage).where(eq(dmMessage.conversationId, conversation));
    expect(rows.find((r) => r.id === target)).toMatchObject({ content: {}, deletedAt: expect.any(Date) });
    expect(rows.filter((r) => r.targetId === target && r.kind !== "delete").every((r) => r.deletedAt && Object.keys(r.content).length === 0)).toBe(true);
    await expect(appendDirectMessage(auth("bob"), conversation, input("bob", "reaction", target))).rejects.toThrow("not found");
    const page = await listDirectMessages(bob, conversation, undefined, target);
    expect(page.messages.every((m) => m.id > target)).toBe(true);
    expect((await listDirectConversations(bob))[0].unread).toBe(0);
  }, 15_000);
  it("does not expose typing to outsiders or after blocking", async () => {
    await expect(publishDirectTyping(outsider, conversation, true)).rejects.toThrow();
    expect(await canReceiveDirectTyping(bob, alice, conversation)).toBe(true);
    await publishDirectTyping(alice, conversation, true);
    await blockUser(bob, alice);
    expect(await canReceiveDirectTyping(bob, alice, conversation)).toBe(false);
    await expect(publishDirectTyping(alice, conversation, true)).rejects.toThrow();
  });
});
