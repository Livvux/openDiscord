import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boundedHistory, pruneDeletedHistory, historyEntrySchema, MAX_HISTORY_BYTES, MAX_HISTORY_COPIES } from "@/lib/dm/history";

function entry(body: string) {
  const conversationId = randomUUID(), transactionId = randomUUID(), deviceId = randomUUID();
  return historyEntrySchema.parse({
    envelope: { id: randomUUID(), conversationId, senderId: "fixture", deviceId, transactionId, createdAt: new Date().toISOString(),
      content: { algorithm: "m.megolm.v1.aes-sha2", sender_key: "a".repeat(43), device_id: deviceId, session_id: "b".repeat(43), ciphertext: "c".repeat(24_000) } },
    message: { msgtype: "m.text", body, conversation: conversationId, transaction: transactionId }, verifiedAt: new Date().toISOString(),
  });
}

describe("authenticated source history capacity", () => {
  it("prunes author-deleted copies even when only a recent edit remains in the bounded cache", () => {
    const original = entry("Original private copy");
    const edit = entry("Edited private copy");
    edit.message.operation = { kind: "edit", target: original.envelope.id };
    expect(pruneDeletedHistory([original, edit], original.envelope.id, "outsider")).toEqual([original, edit]);
    expect(pruneDeletedHistory([original, edit], original.envelope.id, "fixture")).toEqual([]);
    expect(pruneDeletedHistory([edit], original.envelope.id, "fixture")).toEqual([]);
    expect(pruneDeletedHistory([edit], original.envelope.id, "outsider")).toEqual([edit]);
  });
  it("keeps newest loaded Unicode copies within the backup byte budget", () => {
    const entries = Array.from({ length: MAX_HISTORY_COPIES }, () => entry("界".repeat(4000)));
    const retained = boundedHistory(entries);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(entries.length);
    expect(retained.at(-1)).toBe(entries.at(-1));
    expect(new TextEncoder().encode(JSON.stringify(retained)).length).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
  });
  it("never lets a flood of reactions, edits or deletes evict authenticated message copies", () => {
    const messages = Array.from({ length: 30 }, (_, i) => entry(`Message ${i}`));
    const ops = Array.from({ length: 400 }, (_, i) => {
      const op = entry(`👍 ${i}`);
      op.envelope.kind = "reaction";
      op.message.operation = { kind: "reaction", target: messages[i % 3].envelope.id, emoji: "👍", active: i % 2 === 0 };
      return op;
    });
    const orphan = entry("Edit of an unloaded message");
    orphan.message.operation = { kind: "edit", target: randomUUID() };
    const retained = boundedHistory([...messages, ...ops, orphan]);
    for (const message of messages) expect(retained).toContain(message);
    expect(retained).not.toContain(orphan);
    expect(retained.length).toBeLessThanOrEqual(MAX_HISTORY_COPIES);
    // Original order is preserved, and the newest operations on retained messages fill the rest.
    expect(retained.map((e) => e.envelope.id)).toEqual([...messages, ...ops].filter((e) => retained.includes(e)).map((e) => e.envelope.id));
    expect(retained.at(-1)).toBe(ops.at(-1));
  });
  it("retains empty and smaller histories without changing their order", () => {
    const entries = [entry("First"), entry("Second")];
    expect(boundedHistory([])).toEqual([]);
    expect(boundedHistory(entries)).toEqual(entries);
  });
});
