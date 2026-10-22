import { describe, expect, it } from "vitest";
import { projectDmTimeline, searchDmTimeline, type DecryptedDmEvent } from "@/lib/dm/timeline";
import { plainMessageSchema } from "@/lib/dm/contracts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const message = (n: number, senderId = "alice", body = "Original private text"): Extract<DecryptedDmEvent, { body: string }> => ({ id: id(n), senderId, own: senderId === "alice", createdAt: "2026-10-22T10:00:00Z", body, attachments: [] });

describe("authenticated encrypted message updates", () => {
  it("applies edits only from the original author and retains the original reply and files", () => {
    const original = { ...message(1), replyTo: id(9) };
    const forged = { ...message(2, "bob", "Forged"), operation: { kind: "edit" as const, target: id(1) } };
    const edit = { ...message(3, "alice", "Corrected text"), operation: { kind: "edit" as const, target: id(1) } };
    expect(projectDmTimeline([forged, original])[0].body).toBe("Original private text");
    expect(projectDmTimeline([edit, original, forged])).toEqual([{ ...original, body: "Corrected text", edited: true }]);
  });
  it("deduplicates a person's reactions and supports removal without another person's reaction disappearing", () => {
    const reaction = (n: number, sender: string, active: boolean): DecryptedDmEvent => ({ ...message(n, sender, ""), operation: { kind: "reaction", target: id(1), emoji: "👍", active } });
    const projected = projectDmTimeline([message(1), reaction(2, "bob", true), reaction(3, "bob", true), reaction(4, "alice", true), reaction(5, "bob", false)]);
    expect(projected[0].reactions).toEqual([{ emoji: "👍", users: ["alice"] }]);
  });
  it("deletion is terminal, ignores another sender's deletion and removes text from search", () => {
    const deletion = (n: number, sender: string): DecryptedDmEvent => ({ ...message(n, sender, ""), operation: { kind: "delete", target: id(1) } });
    expect(projectDmTimeline([message(1), deletion(2, "bob")])[0].deleted).toBeUndefined();
    const projected = projectDmTimeline([message(1), deletion(2, "alice"), { ...message(3, "alice", "Resurrected"), operation: { kind: "edit", target: id(1) } }]);
    expect(projected[0]).toMatchObject({ body: "", deleted: true, attachments: [] });
    expect(searchDmTimeline(projected, "Original")).toEqual([]);
  });
  it("never displays an update without its target and searches only current text locally", () => {
    expect(projectDmTimeline([{ ...message(2), operation: { kind: "edit", target: id(1) } }])).toEqual([]);
    const messages = projectDmTimeline([message(1), { ...message(2, "alice", "Revised secret"), operation: { kind: "edit", target: id(1) } }]);
    expect(searchDmTimeline(messages, "ORIGINAL")).toEqual([]);
    expect(searchDmTimeline(messages, "revised")).toHaveLength(1);
  });
  it("accepts legacy messages, binds replies inside ciphertext and rejects malformed control payloads", () => {
    const legacy = { msgtype: "m.text", body: "hello", conversation: id(1), transaction: id(2) };
    expect(plainMessageSchema.parse(legacy)).toEqual(legacy);
    expect(plainMessageSchema.parse({ ...legacy, replyTo: id(3) }).replyTo).toBe(id(3));
    expect(plainMessageSchema.safeParse({ ...legacy, body: "", operation: { kind: "edit", target: id(3) } }).success).toBe(false);
    expect(plainMessageSchema.safeParse({ ...legacy, replyTo: id(3), operation: { kind: "delete", target: id(3) } }).success).toBe(false);
  });
});
