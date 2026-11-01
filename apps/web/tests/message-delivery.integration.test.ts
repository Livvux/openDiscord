import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { message, messageSend } from "@/db/schema";
import { acceptInvite, createChannel, createCommunity, createInvite, setChannelOverride } from "@/server/communities";
import { listRoles } from "@/server/moderation";
import { deleteMessage, sendMessage, sendStatus } from "@/server/messages";
import { Permission } from "@/server/permissions";
import { updateAutomod } from "@/server/automod";
import { exportUserData } from "@/server/account";
import { createPublicChannel, publicChannelState, unpublishChannel } from "@/server/public-channels";
import * as realtime from "@/server/realtime";
import { testUsers } from "./helpers";

const users = testUsers();
afterAll(() => users.cleanup());
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const owner = await users.create("Delivery");
  return { owner, ...await createCommunity(owner, "Delivery") };
}

describe("community message delivery", () => {
  it("deduplicates concurrent retries without consuming additional message budget", async () => {
    const { owner, channelId } = await fixture();
    const transaction = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      sendMessage(owner, channelId, "one delivery", [], null, null, null, transaction)));
    expect(new Set(results.map((m) => m.id)).size).toBe(1);
    expect(await db.$count(message, eq(message.channelId, channelId))).toBe(1);
    for (let i = 0; i < 4; i++) await sendMessage(owner, channelId, `new ${i}`);
    await expect(sendMessage(owner, channelId, "over budget")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("rejects reusing an ID for different text or another channel", async () => {
    const { owner, channelId, communityId } = await fixture();
    const other = await createChannel(owner, communityId, "other");
    const transaction = randomUUID();
    await sendMessage(owner, channelId, "original", [], null, null, null, transaction);
    await expect(sendMessage(owner, channelId, "changed", [], null, null, null, transaction)).rejects.toMatchObject({ code: "conflict" });
    await expect(sendMessage(owner, other, "original", [], null, null, null, transaction)).rejects.toMatchObject({ code: "conflict" });
    expect(await db.$count(message, eq(message.channelId, other))).toBe(0);
  });

  it("reports only the caller's own send receipts, without content", async () => {
    const { owner, channelId } = await fixture();
    const other = await users.create("Other sender");
    const [kept, removed, missing] = [randomUUID(), randomUUID(), randomUUID()];
    await sendMessage(owner, channelId, "kept", [], null, null, null, kept);
    const gone = await sendMessage(owner, channelId, "removed", [], null, null, null, removed);
    await deleteMessage(owner, gone.id);
    expect(await sendStatus(owner, [kept, removed, missing])).toEqual({ [kept]: "sent", [removed]: "deleted" });
    // Someone else's receipts are invisible, even with the exact ids.
    expect(await sendStatus(other, [kept, removed])).toEqual({});
    await expect(sendStatus(owner, ["not-a-uuid"])).rejects.toMatchObject({ code: "invalid" });
    await expect(sendStatus(owner, Array.from({ length: 21 }, () => randomUUID()))).rejects.toMatchObject({ code: "invalid" });
  });

  it("retains a tombstone so retrying a deleted message cannot recreate it", async () => {
    const { owner, channelId } = await fixture();
    const transaction = randomUUID();
    const sent = await sendMessage(owner, channelId, "deleted", [], null, null, null, transaction);
    await deleteMessage(owner, sent.id);
    expect((await exportUserData(owner)).messageSends).toEqual([
      { transactionId: transaction, channelId, messageId: null, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    await expect(sendMessage(owner, channelId, "deleted", [], null, null, null, transaction)).rejects.toMatchObject({ code: "conflict" });
    expect(await db.$count(message, eq(message.channelId, channelId))).toBe(0);
  });

  it("scopes send IDs to the author and rechecks revoked permissions on replay", async () => {
    const { owner, channelId, communityId } = await fixture();
    const member = await users.create("Member");
    await acceptInvite(member, await createInvite(owner, communityId, { expiresInHours: 1, maxUses: 1 }));
    const transaction = randomUUID();
    const first = await sendMessage(owner, channelId, "same ID", [], null, null, null, transaction);
    const second = await sendMessage(member, channelId, "same ID", [], null, null, null, transaction);
    expect(second.id).not.toBe(first.id);
    const everyone = (await listRoles(owner, communityId)).find((role) => role.isDefault)!;
    await setChannelOverride(owner, channelId, everyone.id, 0, Permission.SendMessages);
    await expect(sendMessage(member, channelId, "same ID", [], null, null, null, transaction)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rolls back the message and retry receipt when event publication fails", async () => {
    const { owner, channelId } = await fixture();
    const transaction = randomUUID();
    const publish = vi.spyOn(realtime, "publish").mockRejectedValueOnce(new Error("notification unavailable"));
    await expect(sendMessage(owner, channelId, "atomic", [], null, null, null, transaction)).rejects.toThrow("notification unavailable");
    expect(await db.$count(message, eq(message.channelId, channelId))).toBe(0);
    expect(await db.$count(messageSend, and(eq(messageSend.userId, owner), eq(messageSend.transactionId, transaction)))).toBe(0);
    publish.mockRestore();
    await expect(sendMessage(owner, channelId, "atomic", [], null, null, null, transaction)).resolves.toMatchObject({ content: "atomic" });
  });

  it("does not publish duplicate events on a retry after a lost response", async () => {
    const { owner, channelId, communityId } = await fixture();
    const recipient = await users.create("Mention recipient");
    await acceptInvite(recipient, await createInvite(owner, communityId, { expiresInHours: 1, maxUses: 1 }));
    const publish = vi.spyOn(realtime, "publish");
    const transaction = randomUUID();
    const content = `response lost <@${recipient}>`;
    const first = await sendMessage(owner, channelId, content, [], null, null, null, transaction);
    const retry = await sendMessage(owner, channelId, content, [], null, null, null, transaction);
    expect(retry.id).toBe(first.id);
    expect(publish.mock.calls.filter(([event]) => event.type === "message.created")).toHaveLength(1);
    expect(publish.mock.calls.filter(([event]) => event.type === "mention.created")).toHaveLength(1);
    expect(publish.mock.calls[0]?.[1]).toBeDefined();
  });

  it("resolves a committed reply after its parent is deleted and AutoMod changes", async () => {
    const { owner, channelId, communityId } = await fixture();
    const member = await users.create("Reply author");
    await acceptInvite(member, await createInvite(owner, communityId, { expiresInHours: 1, maxUses: 1 }));
    const parent = await sendMessage(owner, channelId, "parent");
    const transaction = randomUUID();
    const first = await sendMessage(member, channelId, "previously allowed", [], parent.id, null, null, transaction);
    await deleteMessage(owner, parent.id);
    await updateAutomod(owner, communityId, { words: ["allowed"], blockLinks: false });
    const retry = await sendMessage(member, channelId, "previously allowed", [], parent.id, null, null, transaction);
    expect(retry.id).toBe(first.id);
    expect(retry.replyTo).toBeNull();
    await expect(sendMessage(member, channelId, "previously allowed")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("resolves an already committed public send after unpublication without permitting new posts", async () => {
    const { owner, communityId } = await fixture();
    const channelId = await createPublicChannel(owner, communityId, { name: "public", communityTitle: "Public", acknowledge: true });
    const { generation } = (await publicChannelState(owner, channelId))!;
    const transaction = randomUUID();
    const sent = await sendMessage(owner, channelId, "published", [], null, null, generation, transaction);
    await unpublishChannel(owner, channelId);
    expect((await sendMessage(owner, channelId, "published", [], null, null, generation, transaction)).id).toBe(sent.id);
    await expect(sendMessage(owner, channelId, "new post", [], null, null, generation, randomUUID())).rejects.toThrow();
  });
});
