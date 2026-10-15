import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boundedHistory, historyEntrySchema, MAX_HISTORY_BYTES, MAX_HISTORY_COPIES } from "@/lib/dm/history";

function entry(body: string) {
  const conversationId = randomUUID(), transactionId = randomUUID(), deviceId = randomUUID();
  return historyEntrySchema.parse({
    envelope: { id: randomUUID(), conversationId, senderId: "fixture", deviceId, transactionId, createdAt: new Date().toISOString(),
      content: { algorithm: "m.megolm.v1.aes-sha2", sender_key: "a".repeat(43), device_id: deviceId, session_id: "b".repeat(43), ciphertext: "c".repeat(24_000) } },
    message: { msgtype: "m.text", body, conversation: conversationId, transaction: transactionId }, verifiedAt: new Date().toISOString(),
  });
}

describe("authenticated source history capacity", () => {
  it("keeps newest loaded Unicode copies within the backup byte budget", () => {
    const entries = Array.from({ length: MAX_HISTORY_COPIES }, () => entry("界".repeat(4000)));
    const retained = boundedHistory(entries);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(entries.length);
    expect(retained.at(-1)).toBe(entries.at(-1));
    expect(new TextEncoder().encode(JSON.stringify(retained)).length).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
  });
  it("retains empty and smaller histories without changing their order", () => {
    const entries = [entry("First"), entry("Second")];
    expect(boundedHistory([])).toEqual([]);
    expect(boundedHistory(entries)).toEqual(entries);
  });
});
