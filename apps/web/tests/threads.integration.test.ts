// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, createChannel, createCommunity, createInvite } from "@/server/communities";
import { deleteMessage, listMessages, sendMessage } from "@/server/messages";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string, outsider: string;
let communityId: string, generalId: string;

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all(["Owner", "Member", "Outsider"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "Threads"));
  await acceptInvite(member, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
});
afterAll(() => users.cleanup());

describe("threads", () => {
  it("keeps thread replies out of the channel and summarises them on the root", async () => {
    const root = await sendMessage(owner, generalId, "Plan for Friday?");
    const a = await sendMessage(member, generalId, "I can bring snacks", [], null, root.id);
    await sendMessage(owner, generalId, "great", [], null, root.id);
    expect(a.threadId).toBe(root.id);

    const channel = await listMessages(member, generalId);
    expect(channel.messages.map((m) => m.content)).not.toContain("I can bring snacks");
    expect(channel.messages.find((m) => m.id === root.id)?.thread).toMatchObject({ count: 2 });

    const thread = await listMessages(member, generalId, undefined, root.id);
    expect(thread.messages.map((m) => m.content)).toEqual(["I can bring snacks", "great"]);
    expect(thread.messages.every((m) => m.thread === null)).toBe(true);
  });

  it("allows threads only on top-level messages of the same channel", async () => {
    const root = await sendMessage(owner, generalId, "root");
    const reply = await sendMessage(member, generalId, "in thread", [], null, root.id);
    await expect(sendMessage(member, generalId, "nested", [], null, reply.id)).rejects.toThrow("Thread not found.");
    const other = await createChannel(owner, communityId, "other");
    await expect(sendMessage(member, other, "elsewhere", [], null, root.id)).rejects.toThrow("Thread not found.");
    await expect(listMessages(member, other, undefined, root.id)).rejects.toThrow("Thread not found.");
    await expect(listMessages(outsider, generalId, undefined, root.id)).rejects.toThrow("Channel not found.");
  });

  it("deletes a thread with its root", async () => {
    const root = await sendMessage(member, generalId, "temporary topic");
    await sendMessage(owner, generalId, "reply", [], null, root.id);
    await deleteMessage(member, root.id);
    await expect(listMessages(owner, generalId, undefined, root.id)).rejects.toThrow("Thread not found.");
  });
});
