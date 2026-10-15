// Requires a migrated database at DATABASE_URL.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { integration, user } from "@/db/schema";
import { updateAutomod } from "@/server/automod";
import { acceptInvite, createChannel, createCommunity, createInvite, deleteCommunity, getCommunityView, setChannelOverride } from "@/server/communities";
import { createIntegration, listIntegrations, postWebhookMessage, requireBot, revokeIntegration } from "@/server/integrations";
import { listMessages, sendMessage } from "@/server/messages";
import { listMembers, listRoles } from "@/server/moderation";
import { Permission } from "@/server/permissions";
import { hub, userTopic, type HubEvent } from "@/server/realtime";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string;
let communityId: string, generalId: string;
const auth = (token: string) => new Headers({ authorization: `Bot ${token}` });

beforeAll(async () => {
  [owner, member] = await Promise.all(["Owner", "Member"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "Integrated"));
  await acceptInvite(member, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
});
afterAll(() => users.cleanup());

describe("bots", () => {
  it("are created by community managers, join as members and act through the same permission checks", async () => {
    await expect(createIntegration(member, communityId, { kind: "bot", name: "Nope" })).rejects.toThrow("permission");
    const { id, token } = await createIntegration(owner, communityId, { kind: "bot", name: "Release bot" });
    expect(token).toMatch(/^od_bot_[A-Za-z0-9_-]{43}$/);
    // Only the hash is stored.
    const [row] = await db.select().from(integration).where(eq(integration.id, id));
    expect(row.tokenHash).not.toContain(token);
    const { userId: botId } = await requireBot(auth(token));
    expect((await listMembers(owner, communityId)).map((m) => m.name)).toContain("Release bot");

    const sent = await sendMessage(botId, generalId, "v1.2 is out");
    expect(sent).toMatchObject({ authorName: "Release bot", authorBot: true });
    expect((await listMessages(botId, generalId)).messages.at(-1)?.content).toBe("v1.2 is out");

    const announcements = await createChannel(owner, communityId, "announcements");
    const everyone = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
    await setChannelOverride(owner, announcements, everyone, 0, Permission.SendMessages);
    await expect(sendMessage(botId, announcements, "hi")).rejects.toThrow("permission");

    await revokeIntegration(owner, id);
    await expect(requireBot(auth(token))).rejects.toThrow("invalid bot token");
    await expect(getCommunityView(botId, communityId)).rejects.toThrow("Community not found.");
    // Past messages keep their bot badge.
    expect((await listMessages(owner, generalId)).messages.find((m) => m.id === sent.id)?.authorBot).toBe(true);
    expect(await listIntegrations(owner, communityId)).toEqual([]);
  });

  it("rejects malformed and unknown tokens the same way", async () => {
    for (const header of ["", "Bearer x", "Bot od_bot_short", `Bot od_bot_${"a".repeat(43)}`]) {
      await expect(requireBot(new Headers({ authorization: header }))).rejects.toThrow("invalid bot token");
    }
  });
});

describe("webhooks", () => {
  it("post plain messages into their channel; wrong pairs and revoked hooks are not found", async () => {
    const { id, token } = await createIntegration(owner, communityId, { kind: "webhook", name: "CI", channelId: generalId });
    const posted = await postWebhookMessage(id, token, { content: "Build #42 passed" });
    expect(posted).toMatchObject({ channelId: generalId, authorName: "CI", authorBot: true });
    const other = await createIntegration(owner, communityId, { kind: "webhook", name: "Other", channelId: generalId });
    await expect(postWebhookMessage(id, other.token, { content: "x" })).rejects.toThrow("Webhook not found.");
    await expect(postWebhookMessage(id, token, { content: "" })).rejects.toThrow();
    await revokeIntegration(owner, id);
    await expect(postWebhookMessage(id, token, { content: "after revoke" })).rejects.toThrow("Webhook not found.");
  });

  it("render mentions without notifying, and are subject to AutoMod", async () => {
    const { id, token } = await createIntegration(owner, communityId, { kind: "webhook", name: "Pinger", channelId: generalId });
    const received: HubEvent[] = [];
    const unsubscribe = hub.subscribe(userTopic(member), (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 300));
    const posted = await postWebhookMessage(id, token, { content: `hey <@${member}>` });
    expect(posted.mentions).toEqual([{ id: member, name: "Member" }]);
    await new Promise((r) => setTimeout(r, 300));
    expect(received.filter((e) => e.type === "mention.created")).toEqual([]);
    unsubscribe();
    await updateAutomod(owner, communityId, { words: ["spam"], blockLinks: false });
    await expect(postWebhookMessage(id, token, { content: "buy spam" })).rejects.toThrow("blocked word");
  });

  it("only target text channels of the same community", async () => {
    const elsewhere = await createCommunity(owner, "Elsewhere");
    await expect(createIntegration(owner, communityId, { kind: "webhook", name: "X", channelId: elsewhere.channelId })).rejects.toThrow("Channel not found.");
  });

  it("disappear with their community, including their accounts", async () => {
    const temp = await createCommunity(owner, "Temporary");
    await createIntegration(owner, temp.communityId, { kind: "bot", name: "Temp bot" });
    const [row] = await db.select().from(integration).where(eq(integration.communityId, temp.communityId));
    await deleteCommunity(owner, temp.communityId);
    expect(await db.select().from(user).where(eq(user.id, row.userId))).toEqual([]);
  });
});
