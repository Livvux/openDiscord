// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, createChannel, createCommunity, createInvite, setChannelOverride } from "@/server/communities";
import { deleteMessage, listMessages, listPinned, MAX_PINS_PER_CHANNEL, sendMessage, setPinned, toggleReaction } from "@/server/messages";
import { MAX_EMOJIS_PER_MESSAGE } from "@/server/message-extras";
import { listAuditLog, listRoles } from "@/server/moderation";
import { Permission } from "@/server/permissions";
import { db } from "@/db";
import { message, reaction } from "@/db/schema";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string, reader: string;
let communityId: string, generalId: string;

beforeAll(async () => {
  [owner, member, reader] = await Promise.all(["Owner", "Member", "Reader"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "Features"));
  for (const u of [member, reader]) await acceptInvite(u, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
});
afterAll(() => users.cleanup());

describe("replies", () => {
  it("links a reply to a message in the same channel with a preview", async () => {
    const parent = await sendMessage(owner, generalId, `question for <@${member}>?`);
    const reply = await sendMessage(member, generalId, "answer", [], parent.id);
    expect(reply.replyTo).toEqual({ id: parent.id, authorId: owner, authorName: "Owner", authorImported: false, excerpt: "question for @Member?" });
  });

  it("refuses replies across channels and to unknown messages", async () => {
    const other = await createChannel(owner, communityId, "other");
    const elsewhere = await sendMessage(owner, other, "elsewhere");
    await expect(sendMessage(member, generalId, "x", [], elsewhere.id)).rejects.toThrow("deleted");
    await expect(sendMessage(member, generalId, "x", [], "01ffffff-ffff-7fff-bfff-ffffffffffff")).rejects.toThrow("deleted");
  });

  it("keeps the reply when the parent is deleted, without a preview", async () => {
    const parent = await sendMessage(reader, generalId, "temporary");
    const reply = await sendMessage(member, generalId, "re", [], parent.id);
    await deleteMessage(reader, parent.id);
    const page = await listMessages(owner, generalId);
    expect(page.messages.find((m) => m.id === reply.id)?.replyTo).toBeNull();
  });
});

describe("reactions", () => {
  it("toggles a person's reaction and groups by emoji", async () => {
    const msg = await sendMessage(owner, generalId, "react to me");
    await toggleReaction(member, msg.id, "👍");
    await toggleReaction(reader, msg.id, "👍");
    await toggleReaction(reader, msg.id, "🎉");
    let view = (await listMessages(owner, generalId)).messages.find((m) => m.id === msg.id)!;
    expect(view.reactions).toEqual([{ emoji: "👍", userIds: [member, reader] }, { emoji: "🎉", userIds: [reader] }]);
    await toggleReaction(member, msg.id, "👍");
    view = (await listMessages(owner, generalId)).messages.find((m) => m.id === msg.id)!;
    expect(view.reactions[0]).toEqual({ emoji: "👍", userIds: [reader] });
  });

  it("accepts emoji sequences but not text", async () => {
    const msg = await sendMessage(owner, generalId, "emoji");
    await expect(toggleReaction(member, msg.id, "👍🏽")).resolves.toBeUndefined();
    await expect(toggleReaction(member, msg.id, "👨‍👩‍👧")).resolves.toBeUndefined();
    await expect(toggleReaction(member, msg.id, "🇩🇪")).resolves.toBeUndefined();
    await expect(toggleReaction(member, msg.id, "❤️")).resolves.toBeUndefined();
    await expect(toggleReaction(member, msg.id, "1️⃣")).resolves.toBeUndefined();
    for (const bad of ["lol", "<b>", "1", "👍x", "", "😀0000", "👍👍", "🇩"]) await expect(toggleReaction(member, msg.id, bad)).rejects.toThrow();
  });

  it("caps distinct emojis per message", async () => {
    const [msg] = await db.insert(message).values({ channelId: generalId, authorId: owner, content: "many" }).returning();
    const emojis = ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚", "😋", "😛"];
    // Seeded directly: toggling 20 times would hit the reaction burst limit.
    await db.insert(reaction).values(emojis.slice(0, MAX_EMOJIS_PER_MESSAGE).map((emoji) => ({ messageId: msg.id, userId: owner, emoji })));
    await expect(toggleReaction(member, msg.id, emojis[MAX_EMOJIS_PER_MESSAGE])).rejects.toThrow("at most");
    // Joining an existing emoji is still allowed.
    await expect(toggleReaction(member, msg.id, emojis[0])).resolves.toBeUndefined();
  });

  it("rate-limits reaction toggles per person", async () => {
    const msg = await sendMessage(reader, generalId, "spam target");
    const spammer = await users.create("Spammer");
    await acceptInvite(spammer, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
    for (let i = 0; i < 10; i++) await toggleReaction(spammer, msg.id, "👍");
    await expect(toggleReaction(spammer, msg.id, "👍")).rejects.toThrow("too often");
  });

  it("needs send permission in the channel", async () => {
    const readOnly = await createChannel(owner, communityId, "read-only");
    const everyone = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
    await setChannelOverride(owner, readOnly, everyone, 0, Permission.SendMessages);
    const [msg] = await db.insert(message).values({ channelId: readOnly, authorId: owner, content: "announcement" }).returning();
    await expect(toggleReaction(member, msg.id, "👍")).rejects.toThrow("permission");
  });
});

describe("pins", () => {
  it("lets moderators pin and unpin, audited, and lists pins newest first", async () => {
    const a = await sendMessage(member, generalId, "pin a");
    const b = await sendMessage(member, generalId, "pin b");
    await expect(setPinned(member, a.id, true)).rejects.toThrow("permission");
    await setPinned(owner, a.id, true);
    await setPinned(owner, b.id, true);
    expect((await listPinned(reader, generalId)).map((m) => m.content)).toEqual(["pin b", "pin a"]);
    await setPinned(owner, a.id, false);
    expect((await listPinned(reader, generalId)).map((m) => m.id)).toEqual([b.id]);
    expect((await listAuditLog(owner, communityId)).map((e) => e.action)).toEqual(expect.arrayContaining(["message.pin", "message.unpin"]));
  });

  it("caps pins per channel", async () => {
    const channelId = await createChannel(owner, communityId, "pins");
    const rows = await db.insert(message)
      .values(Array.from({ length: MAX_PINS_PER_CHANNEL + 1 }, (_, i) => ({ channelId, authorId: owner, content: `m${i}`, pinnedAt: i < MAX_PINS_PER_CHANNEL ? new Date() : null })))
      .returning();
    await expect(setPinned(owner, rows.at(-1)!.id, true)).rejects.toThrow("at most");
  });
});
