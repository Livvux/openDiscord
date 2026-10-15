import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { abuseReport, channel, community, member, message, publicChannel, publicPost, user, userSuspension } from "@/db/schema";
import { acceptInvite, createCommunity, createInvite, getCommunityView, updateChannel } from "@/server/communities";
import { exportCommunity, importCommunity } from "@/server/community-export";
import { createIntegration, postWebhookMessage, requireBot } from "@/server/integrations";
import { lockCommunity } from "@/server/access";
import { deleteMessage, editMessage, listMessages, sendMessage } from "@/server/messages";
import { createPublicChannel, listPublicChannels, publicChannelState, readPublicChannel, unpublishChannel } from "@/server/public-channels";
import { reportContent } from "@/server/reports";
import { testUsers } from "./helpers";

const users = testUsers();
const reports: string[] = [];
afterAll(async () => {
  if (reports.length) await db.delete(abuseReport).where(inArray(abuseReport.reporterId, reports));
  await users.cleanup();
});
async function fixture() {
  const owner = await users.create("Public author snapshot");
  const outsider = await users.create("Nonmember reporter");
  const created = await createCommunity(owner, "PRIVATE COMMUNITY NAME");
  const id = await createPublicChannel(owner, created.communityId, { name: "public-text", communityTitle: "Chosen public title", acknowledge: true });
  const state = (await publicChannelState(owner, id))!;
  return { owner, outsider, id, generation: state.generation, ...created };
}
const send = (f: Awaited<ReturnType<typeof fixture>>, text = "Public text") => sendMessage(f.owner, f.id, text, [], null, null, f.generation);

describe("explicitly public text channels", () => {
  it("keeps existing channels private and requires owner consent for NEW channels only", async () => {
    const f = await fixture();
    await sendMessage(f.owner, f.channelId, "PRIVATE HISTORY");
    expect(await readPublicChannel(f.channelId)).toBeNull();
    await expect(createPublicChannel(f.owner, f.communityId, { name: "no-consent", communityTitle: "title", acknowledge: false })).rejects.toThrow();
    await expect(createPublicChannel(f.owner, f.communityId, { channelId: f.channelId, name: "convert", communityTitle: "title", acknowledge: true })).rejects.toThrow();
    await acceptInvite(f.outsider, await createInvite(f.owner, f.communityId, { maxUses: null, expiresInHours: null }));
    await expect(createPublicChannel(f.outsider, f.communityId, { name: "not-owner", communityTitle: "title", acknowledge: true })).rejects.toThrow(/owner/);
    await expect(unpublishChannel(f.outsider, f.id)).rejects.toThrow(/owner/);
    expect((await db.select().from(publicPost).where(eq(publicPost.channelId, f.id)))).toEqual([]);
  });

  it("fails closed for missing/wrong generation, attachments, threads and custom asset tokens", async () => {
    const f = await fixture();
    await expect(sendMessage(f.owner, f.id, "old client")).rejects.toThrow(/Acknowledge/);
    await expect(sendMessage(f.owner, f.id, "wrong", [], null, null, randomUUID())).rejects.toThrow(/Acknowledge/);
    await expect(sendMessage(f.owner, f.id, "file", [randomUUID()], null, null, f.generation)).rejects.toThrow(/text only/);
    await expect(send(f, `<emoji:private_image:${randomUUID()}>`)).rejects.toThrow(/text only/);
    const root = await send(f);
    await expect(sendMessage(f.owner, f.id, "reply", [], root.id, null, f.generation)).rejects.toThrow(/text only/);
    await expect(sendMessage(f.owner, f.id, "thread", [], null, root.id, f.generation)).rejects.toThrow(/text only/);
    await expect(editMessage(f.owner, root.id, "old edit")).rejects.toThrow(/Acknowledge/);
    await expect(editMessage(f.owner, root.id, "wrong edit", randomUUID())).rejects.toThrow(/Acknowledge/);
    await editMessage(f.owner, root.id, "Acknowledged edit", f.generation);
    expect((await readPublicChannel(f.id))!.posts[0]).toMatchObject({ content: "Acknowledged edit", authorName: "Public author snapshot" });
    expect(await db.select().from(message).where(eq(message.channelId, f.id))).toHaveLength(1);
  });

  it("whitelists snapshots and never republishes private account/channel/community renames", async () => {
    const f = await fixture();
    await send(f, `Hello <@${f.outsider}> /api/attachments/${randomUUID()}`);
    await db.update(user).set({ name: "PRIVATE NEW USERNAME" }).where(eq(user.id, f.owner));
    await updateChannel(f.owner, f.id, "private-new-label", "PRIVATE TOPIC");
    const page = (await readPublicChannel(f.id))!;
    expect(page.title).toBe("public-text");
    expect(page.communityTitle).toBe("Chosen public title");
    expect(page.posts[0].authorName).toBe("Public author snapshot");
    expect(page.posts[0].content).toBe("Hello @member [private attachment]");
    const json = JSON.stringify(page);
    for (const hidden of [f.owner, f.outsider, f.communityId, "PRIVATE", "authorId", "attachments", "/api/attachments", "topic", "generation"]) expect(json).not.toContain(hidden);
    expect(Object.keys(page.posts[0]).sort()).toEqual(["authorName", "content", "createdAt", "editedAt", "id"]);
  });

  it("guards bot and webhook writers with the same current consent and revocation state", async () => {
    const f = await fixture();
    const hook = await createIntegration(f.owner, f.communityId, { kind: "webhook", name: "Public webhook", channelId: f.id });
    await expect(postWebhookMessage(hook.id, hook.token, { content: "old webhook" })).rejects.toThrow(/Acknowledge/);
    await expect(postWebhookMessage(hook.id, hook.token, { content: "stale", publicGeneration: randomUUID() })).rejects.toThrow(/Acknowledge/);
    await postWebhookMessage(hook.id, hook.token, { content: `Webhook <@${f.outsider}>`, publicGeneration: f.generation });
    const bot = await createIntegration(f.owner, f.communityId, { kind: "bot", name: "Public bot" });
    const identity = await requireBot(new Headers({ authorization: `Bot ${bot.token}` }));
    await expect(sendMessage(identity.userId, f.id, "old bot")).rejects.toThrow(/Acknowledge/);
    await sendMessage(identity.userId, f.id, "Acknowledged bot", [], null, null, f.generation);
    expect((await readPublicChannel(f.id))!.posts.map((p) => p.content)).toEqual(["Webhook @member", "Acknowledged bot"]);
    await unpublishChannel(f.owner, f.id);
    await expect(postWebhookMessage(hook.id, hook.token, { content: "after", publicGeneration: f.generation })).rejects.toThrow(/unpublished/);
  });

  it("allows authenticated nonmember reports only for current public posts without joining", async () => {
    const f = await fixture(); reports.push(f.outsider);
    const posted = await send(f);
    await reportContent(f.outsider, { messageId: posted.id, reason: "Public report reason" });
    expect(await db.select().from(member).where(and(eq(member.userId, f.outsider), eq(member.communityId, f.communityId)))).toEqual([]);
    const privatePost = await sendMessage(f.owner, f.channelId, "PRIVATE REPORT TARGET");
    await expect(reportContent(f.outsider, { messageId: privatePost.id, reason: "No private context" })).rejects.toThrow();
    await unpublishChannel(f.owner, f.id);
    await expect(reportContent(f.outsider, { messageId: posted.id, reason: "After unpublish" })).rejects.toThrow();
  });

  it("joins suspension/deletion visibility into every read and removes snapshots on deletion", async () => {
    const f = await fixture();
    const posted = await send(f);
    const discovered = async () => (await listPublicChannels()).channels.some((ch) => ch.id === f.id);
    expect(await discovered()).toBe(true);
    await db.update(community).set({ suspendedAt: new Date() }).where(eq(community.id, f.communityId));
    expect(await readPublicChannel(f.id)).toBeNull(); expect(await discovered()).toBe(false);
    await db.update(community).set({ suspendedAt: null }).where(eq(community.id, f.communityId));
    await db.insert(userSuspension).values({ userId: f.owner, reason: "test suspension" });
    expect(await readPublicChannel(f.id)).toBeNull(); expect(await discovered()).toBe(false);
    await db.delete(userSuspension).where(eq(userSuspension.userId, f.owner));
    expect((await readPublicChannel(f.id))!.posts).toHaveLength(1);
    await deleteMessage(f.owner, posted.id);
    expect((await readPublicChannel(f.id))!.posts).toEqual([]);
    expect(await db.select().from(publicPost).where(eq(publicPost.messageId, posted.id))).toEqual([]);
    await db.delete(channel).where(eq(channel.id, f.id));
    expect(await readPublicChannel(f.id)).toBeNull(); expect(await discovered()).toBe(false);
  });

  it("serializes public sends and terminal unpublish under the community lock", async () => {
    const f = await fixture();
    let release!: () => void; let entered!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.transaction(async (tx) => { await lockCommunity(tx, f.communityId); entered(); await gate; });
    await acquired;
    const sending = send(f, "Racing public post");
    const stopping = unpublishChannel(f.owner, f.id);
    release(); await blocker;
    const [sent, stopped] = await Promise.allSettled([sending, stopping]);
    expect(stopped.status).toBe("fulfilled");
    const snapshots = await db.select().from(publicPost).where(eq(publicPost.channelId, f.id));
    expect(snapshots).toHaveLength(sent.status === "fulfilled" ? 1 : 0);
    expect(await readPublicChannel(f.id)).toBeNull();
    await expect(send(f, "After stop")).rejects.toThrow(/unpublished/);
    await expect(unpublishChannel(f.owner, f.id)).rejects.toThrow(/not published/);
    if (sent.status === "fulfilled") await expect(editMessage(f.owner, sent.value.id, "After stop edit", f.generation)).rejects.toThrow(/unpublished/);
  });

  it("bounds pagination, rejects malformed cursors and keeps export/import private", async () => {
    const f = await fixture();
    // Bulk fixtures model already acknowledged snapshots; production writes use the guarded service.
    await db.transaction(async (tx) => {
      const rows = await tx.insert(message).values(Array.from({ length: 35 }, (_, i) => ({ channelId: f.id, authorId: f.owner, content: `Public ${i}` }))).returning();
      await tx.insert(publicPost).values(rows.map((row) => ({ messageId: row.id, channelId: f.id, authorName: "Snapshot", content: row.content, createdAt: row.createdAt })));
    });
    const first = (await readPublicChannel(f.id))!;
    expect(first.posts).toHaveLength(30); expect(first.next).not.toBeNull();
    const older = (await readPublicChannel(f.id, first.next))!;
    expect(older.posts).toHaveLength(5); expect(older.next).toBeNull();
    expect(new Set([...first.posts, ...older.posts].map((post) => post.id)).size).toBe(35);
    expect(await readPublicChannel(f.id, "malformed")).toBeNull();
    expect(await listPublicChannels("malformed")).toEqual({ channels: [], next: null });
    const exported = await exportCommunity(f.owner, f.communityId);
    expect(JSON.stringify(exported)).not.toContain(f.generation);
    expect(JSON.stringify(exported)).not.toContain("Chosen public title");
    const imported = await importCommunity(f.outsider, { ...exported, publicChannel: { generation: f.generation }, channels: exported.channels.map((ch) => ({ ...ch, public: true, publicGeneration: f.generation })) });
    const view = await getCommunityView(f.outsider, imported);
    for (const ch of view.channels) {
      expect(await readPublicChannel(ch.id)).toBeNull();
      expect(await publicChannelState(f.outsider, ch.id)).toBeNull();
    }
    expect((await listMessages(f.outsider, view.channels.find((ch) => ch.name === "public-text")!.id)).messages).toHaveLength(35);
    expect(await db.select().from(publicChannel).where(inArray(publicChannel.channelId, view.channels.map((ch) => ch.id)))).toEqual([]);
  });
});
