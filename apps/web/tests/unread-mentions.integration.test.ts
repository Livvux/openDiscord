// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptInvite,
  createChannel,
  createCommunity,
  createInvite,
  getCommunityView,
  setChannelOverride,
} from "@/server/communities";
import { editMessage, listMessages, sendMessage } from "@/server/messages";
import { listRoles, searchMembers } from "@/server/moderation";
import { Permission } from "@/server/permissions";
import { hub, userTopic, type HubEvent } from "@/server/realtime";
import { communityUnread, markChannelRead } from "@/server/unread";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, ann: string, bob: string, outsider: string;
let communityId: string, generalId: string;

const channelState = async (u: string, channelId: string) =>
  (await getCommunityView(u, communityId)).channels.find((c) => c.id === channelId);

beforeAll(async () => {
  [owner, ann, bob, outsider] = await Promise.all(["Owner", "Ann 100%", "Bob", "Outsider"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "Unread"));
  for (const u of [ann, bob]) await acceptInvite(u, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
});
afterAll(() => users.cleanup());

describe("mentions", () => {
  it("stores mentions of members only, never of the author or outsiders", async () => {
    const sent = await sendMessage(owner, generalId, `hi <@${ann}> <@${owner}> <@${outsider}> <@nobody>`);
    expect(sent.mentions.map((m) => m.id)).toEqual([ann]);
    expect(sent.mentions[0].name).toBe("Ann 100%");
    const page = await listMessages(bob, generalId);
    expect(page.messages.at(-1)?.mentions).toEqual([{ id: ann, name: "Ann 100%" }]);
  });

  it("notifies the mentioned person on their own topic, but never for edits", async () => {
    const received: HubEvent[] = [];
    const unsubscribe = hub.subscribe(userTopic(bob), (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 300));
    const sent = await sendMessage(ann, generalId, `ping <@${bob}>`);
    await expect.poll(() => received.filter((e) => e.type === "mention.created").length).toBe(1);
    expect(received[0]).toMatchObject({ type: "mention.created", userId: bob, channelId: generalId, messageId: sent.id });
    // Editing a mention out and back in must not re-ping.
    await editMessage(ann, sent.id, "ping");
    await editMessage(ann, sent.id, `ping <@${bob}>`);
    await new Promise((r) => setTimeout(r, 300));
    expect(received.filter((e) => e.type === "mention.created")).toHaveLength(1);
    expect((await listMessages(bob, generalId)).messages.find((m) => m.id === sent.id)?.mentions).toEqual([{ id: bob, name: "Bob" }]);
    unsubscribe();
  });

  it("searches members by name prefix, treating LIKE wildcards literally", async () => {
    expect((await searchMembers(owner, communityId, "ann 100%")).map((m) => m.id)).toEqual([ann]);
    expect(await searchMembers(owner, communityId, "%")).toEqual([]);
    await expect(searchMembers(outsider, communityId, "a")).rejects.toThrow("Community not found.");
  });
});

describe("unread state", () => {
  it("marks channels unread when others post, counts mentions, and clears on read", async () => {
    const channelId = await createChannel(owner, communityId, "news");
    expect(await channelState(bob, channelId)).toMatchObject({ unread: false, mentions: 0 });
    await sendMessage(owner, channelId, "update");
    const second = await sendMessage(owner, channelId, `<@${bob}> please read`);
    expect(await channelState(bob, channelId)).toMatchObject({ unread: true, mentions: 1 });
    // Own messages never make a channel unread.
    expect(await channelState(owner, channelId)).toMatchObject({ unread: false, mentions: 0 });
    expect((await communityUnread(bob, [{ id: communityId }])).get(communityId)?.mentions).toBeGreaterThanOrEqual(1);

    await markChannelRead(bob, channelId, second.id);
    expect(await channelState(bob, channelId)).toMatchObject({ unread: false, mentions: 0, lastReadId: second.id });
  });

  it("only accepts messages of the channel as read markers", async () => {
    const channelId = await createChannel(owner, communityId, "markers");
    await expect(markChannelRead(bob, channelId, "01ffffff-ffff-7fff-bfff-ffffffffffff")).rejects.toThrow("Message not found.");
    const elsewhere = await sendMessage(bob, generalId, "elsewhere");
    await expect(markChannelRead(bob, channelId, elsewhere.id)).rejects.toThrow("Message not found.");
  });

  it("never moves the read marker backwards", async () => {
    const channelId = await createChannel(owner, communityId, "forward");
    const first = await sendMessage(ann, channelId, "one");
    const second = await sendMessage(ann, channelId, "two");
    await markChannelRead(bob, channelId, second.id);
    await markChannelRead(bob, channelId, first.id);
    expect((await channelState(bob, channelId))?.lastReadId).toBe(second.id);
  });

  it("ignores channels the person can't see, and refuses to mark them", async () => {
    const hidden = await createChannel(owner, communityId, "hidden");
    const everyone = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
    await setChannelOverride(owner, hidden, everyone, 0, Permission.ViewChannels);
    const sent = await sendMessage(owner, hidden, `<@${bob}> secret`);
    await expect(markChannelRead(bob, hidden, sent.id)).rejects.toThrow("Channel not found.");
    // Read every visible channel: what's left must not include the hidden mention.
    for (const c of (await getCommunityView(bob, communityId)).channels) {
      const newest = (await listMessages(bob, c.id)).messages.at(-1);
      if (newest) await markChannelRead(bob, c.id, newest.id);
    }
    expect((await communityUnread(bob, [{ id: communityId }])).get(communityId)).toEqual({ unread: false, mentions: 0 });
  });
});
