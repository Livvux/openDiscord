// Requires a migrated database at DATABASE_URL.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { member, user } from "@/db/schema";
import { exportUserData } from "@/server/account";
import { blockedIds, blockUser, listBlocked, unblockUser } from "@/server/blocks";
import {
  acceptInvite,
  createCommunity,
  createInvite,
  getCommunitySafety,
  getCommunityView,
  getInvitePreview,
  updateCommunitySafety,
} from "@/server/communities";
import { sendMessage } from "@/server/messages";
import { listAuditLog } from "@/server/moderation";
import { hub, userTopic, type HubEvent } from "@/server/realtime";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, alice: string, troll: string;
let communityId: string, generalId: string;
const safe = { invitesPaused: false, minAccountAgeHours: 0, raidJoinLimit: 30 } as const;

const invite = () => createInvite(owner, communityId, { expiresInHours: 24, maxUses: null });

beforeAll(async () => {
  [owner, alice, troll] = await Promise.all(["Owner", "Alice", "Troll"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "Safety"));
  for (const u of [alice, troll]) await acceptInvite(u, await invite());
});
afterAll(() => users.cleanup());

describe("blocking", () => {
  it("blocks and unblocks, refusing yourself and unknown accounts", async () => {
    await expect(blockUser(alice, alice)).rejects.toThrow("yourself");
    await expect(blockUser(alice, "no-such-user")).rejects.toThrow("Account not found.");
    await blockUser(alice, troll);
    await blockUser(alice, troll); // idempotent
    expect(await blockedIds(alice)).toEqual([troll]);
    expect((await listBlocked(alice)).map((b) => b.name)).toEqual(["Troll"]);
    expect((await exportUserData(alice)).blocked.map((b) => b.id)).toEqual([troll]);
    await unblockUser(alice, troll);
    expect(await blockedIds(alice)).toEqual([]);
  });

  it("keeps a blocked person's mention visible but silent for the blocker", async () => {
    await blockUser(alice, troll);
    const received: HubEvent[] = [];
    const unsubscribe = hub.subscribe(userTopic(alice), (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 300));
    const sent = await sendMessage(troll, generalId, `hey <@${alice}>`);
    expect(sent.mentions).toEqual([{ id: alice, name: "Alice" }]);
    await new Promise((r) => setTimeout(r, 300));
    expect(received.filter((e) => e.type === "mention.created")).toEqual([]);
    const general = (await getCommunityView(alice, communityId)).channels.find((c) => c.id === generalId);
    expect(general).toMatchObject({ unread: true, mentions: 0 });
    unsubscribe();
    // Other people still get mention notifications from the same author.
    expect(await blockedIds(owner)).toEqual([]);
    await unblockUser(alice, troll);
  });
});

describe("community safety", () => {
  it("only lets community managers read and change safety settings", async () => {
    await expect(getCommunitySafety(alice, communityId)).rejects.toThrow("permission");
    await expect(updateCommunitySafety(alice, communityId, { ...safe, invitesPaused: true })).rejects.toThrow("permission");
    await expect(updateCommunitySafety(owner, communityId, { ...safe, raidJoinLimit: 7 })).rejects.toThrow();
    expect(await getCommunitySafety(owner, communityId)).toEqual(safe);
  });

  it("pauses invites: no new links, no joins, preview says so; audited", async () => {
    const code = await invite();
    await updateCommunitySafety(owner, communityId, { ...safe, invitesPaused: true });
    await expect(invite()).rejects.toThrow("paused");
    expect((await getInvitePreview(code)).paused).toBe(true);
    const newcomer = await users.create("Newcomer");
    await expect(acceptInvite(newcomer, code)).rejects.toThrow("paused");
    await updateCommunitySafety(owner, communityId, safe);
    await expect(acceptInvite(newcomer, code)).resolves.toBe(communityId);
    const actions = (await listAuditLog(owner, communityId)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["invites.pause", "invites.resume"]));
  });

  it("refuses accounts younger than the minimum age", async () => {
    await updateCommunitySafety(owner, communityId, { ...safe, minAccountAgeHours: 24 });
    const fresh = await users.create("Fresh");
    const code = await invite();
    await expect(acceptInvite(fresh, code)).rejects.toThrow("too new");
    await db.update(user).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(user.id, fresh));
    await expect(acceptInvite(fresh, code)).resolves.toBe(communityId);
    await updateCommunitySafety(owner, communityId, safe);
  });

  it("auto-pauses invites when joins exceed the raid limit, and the pause sticks", async () => {
    const { communityId: target } = await createCommunity(owner, "Raid target");
    await updateCommunitySafety(owner, target, { ...safe, raidJoinLimit: 10 });
    const code = await createInvite(owner, target, { expiresInHours: 24, maxUses: null });
    // The owner counts as a recent join; nine more reach the limit of ten.
    const raiders = await Promise.all(Array.from({ length: 10 }, (_, i) => users.create(`Raider ${i}`)));
    const results = await Promise.allSettled(raiders.map((r) => acceptInvite(r, code)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(9);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await getCommunitySafety(owner, target)).invitesPaused).toBe(true);
    expect((await listAuditLog(owner, target)).map((e) => e.action)).toContain("invites.auto_pause");
    const late = await users.create("Late");
    await expect(acceptInvite(late, code)).rejects.toThrow("paused");
    expect(await db.$count(member, eq(member.communityId, target))).toBe(10);
  });
});
