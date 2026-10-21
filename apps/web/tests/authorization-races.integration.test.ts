import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { db } from "@/db";
import { category, channel, community, invite, message } from "@/db/schema";
import * as access from "@/server/access";
import { createCategory, deleteCategory, renameCategory, setChannelCategory } from "@/server/categories";
import { acceptInvite, createCommunity, createInvite, renameCommunity, revokeInvite, updateChannel } from "@/server/communities";
import { AppError } from "@/server/errors";
import { deleteMessage, RATE_LIMIT, sendMessage, setPinned } from "@/server/messages";
import { createRole, setMemberRole } from "@/server/moderation";
import { testUsers } from "./helpers";

const users = testUsers();
afterAll(() => users.cleanup());
afterEach(() => vi.restoreAllMocks());

const operations = ["community.rename", "channel.update", "invite.revoke", "category.rename", "category.delete", "channel.category", "message.delete", "message.pin"] as const;

it.each(operations)("%s cannot use permission checked before a committed revocation", async (operation) => {
  const owner = await users.create("Race owner");
  const actor = await users.create("Race moderator");
  const { communityId, channelId } = await createCommunity(owner, "Original community");
  await acceptInvite(actor, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
  const roleId = await createRole(owner, communityId, "Temporary moderator", ["ManageCommunity", "ManageChannels", "ManageMessages"]);
  await setMemberRole(owner, roleId, actor, true);
  const categoryId = await createCategory(owner, communityId, "Original category");
  const code = await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 });
  const post = await sendMessage(owner, channelId, "Keep this message");
  const snapshot = async () => ({
    communities: await db.select().from(community).where(eq(community.id, communityId)),
    channels: await db.select().from(channel).where(eq(channel.id, channelId)),
    categories: await db.select().from(category).where(eq(category.id, categoryId)),
    invites: await db.select().from(invite).where(eq(invite.code, code)),
    messages: await db.select().from(message).where(eq(message.id, post.id)),
  });
  const before = await snapshot();
  let authorized!: () => void;
  let resume!: () => void;
  const checked = new Promise<void>((resolve) => { authorized = resolve; });
  const revoked = new Promise<void>((resolve) => { resume = resolve; });
  let paused = false;
  const pause = async (database: access.Db, userId: string) => {
    if (database !== db || userId !== actor || paused) return;
    paused = true;
    authorized();
    await revoked;
  };
  // Delegate to the real database authorization first, then commit the real role
  // revocation before letting the request continue. No fabricated permission result.
  const requireMember = access.requireMember;
  vi.spyOn(access, "requireMember").mockImplementation(async (...args) => {
    const result = await requireMember(...args);
    await pause(args[0], args[2]);
    return result;
  });
  const requireChannel = access.requireChannel;
  vi.spyOn(access, "requireChannel").mockImplementation(async (...args) => {
    const result = await requireChannel(...args);
    await pause(args[0], args[2]);
    return result;
  });
  const actions = {
    "community.rename": () => renameCommunity(actor, communityId, "Unauthorized rename"),
    "channel.update": () => updateChannel(actor, channelId, "unauthorized", "Changed topic"),
    "invite.revoke": () => revokeInvite(actor, code),
    "category.rename": () => renameCategory(actor, categoryId, "Unauthorized rename"),
    "category.delete": () => deleteCategory(actor, categoryId),
    "channel.category": () => setChannelCategory(actor, channelId, categoryId),
    "message.delete": () => deleteMessage(actor, post.id),
    "message.pin": () => setPinned(actor, post.id, true),
  };
  const pending = actions[operation]().then(() => "allowed", (error: unknown) => error instanceof AppError ? error.code : "unexpected");
  try {
    await checked;
    await setMemberRole(owner, roleId, actor, false);
  } finally {
    resume();
  }
  expect(await pending).toBe("forbidden");
  expect(await snapshot()).toEqual(before);
});

it("parallel sends share one atomic sliding-window limit across communities", async () => {
  const actor = await users.create("Parallel sender");
  const first = await createCommunity(actor, "First community");
  const second = await createCommunity(actor, "Second community");
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
  const results = await Promise.allSettled(Array.from({ length: RATE_LIMIT.messages * 2 }, (_, i) =>
    sendMessage(actor, i % 2 ? first.channelId : second.channelId, `Parallel message ${i}`)));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(RATE_LIMIT.messages);
  for (const result of results) {
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "rate_limited" });
  }
  expect(await db.$count(message, eq(message.authorId, actor))).toBe(RATE_LIMIT.messages);
});

it("an unavailable attachment rolls back the message and its rate-limit acquisition", async () => {
  const actor = await users.create("Attachment rollback sender");
  const { channelId } = await createCommunity(actor, "Rollback community");
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
  await expect(sendMessage(actor, channelId, "Unavailable attachment", [randomUUID()]))
    .rejects.toMatchObject({ code: "invalid" });
  expect(await db.$count(message, eq(message.authorId, actor))).toBe(0);
  for (let i = 0; i < RATE_LIMIT.messages; i++) await sendMessage(actor, channelId, `Valid message ${i}`);
  await expect(sendMessage(actor, channelId, "Over the limit")).rejects.toMatchObject({ code: "rate_limited" });
  expect(await db.$count(message, eq(message.authorId, actor))).toBe(RATE_LIMIT.messages);
});
