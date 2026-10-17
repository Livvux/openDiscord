// Requires a migrated database at DATABASE_URL.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { userPresence } from "@/db/schema";
import { acceptInvite, createCommunity, createInvite, getCommunityView } from "@/server/communities";
import { mutedCommunities, onlineMembers, presenceVisible, setNotificationLevel, setPresenceVisible, touchPresence } from "@/server/presence";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, shy: string, social: string, outsider: string;
let communityId: string;

beforeAll(async () => {
  [owner, shy, social, outsider] = await Promise.all(["Owner", "Shy", "Social", "Outsider"].map(users.create));
  ({ communityId } = await createCommunity(owner, "Presence"));
  for (const u of [shy, social]) await acceptInvite(u, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
});
afterAll(() => users.cleanup());

describe("presence", () => {
  it("is hidden by default and shown only after opting in", async () => {
    await touchPresence(shy);
    await touchPresence(social);
    expect(await presenceVisible(shy)).toBe(false);
    expect(await onlineMembers(owner, communityId)).toEqual([]);
    await setPresenceVisible(social, true);
    expect(await onlineMembers(owner, communityId)).toEqual([{ id: social, status: "online" }]);
  });

  it("goes offline after the window and refuses non-members", async () => {
    await db.update(userPresence).set({ lastSeenAt: new Date(Date.now() - 120_000) }).where(eq(userPresence.userId, social));
    expect(await onlineMembers(owner, communityId)).toEqual([]);
    await expect(onlineMembers(outsider, communityId)).rejects.toThrow("Community not found.");
  });

  it("throttles heartbeat writes", async () => {
    const t0 = new Date();
    await db.update(userPresence).set({ lastSeenAt: t0 }).where(eq(userPresence.userId, shy));
    await touchPresence(shy, new Date(t0.getTime() + 10_000));
    const [row] = await db.select().from(userPresence).where(eq(userPresence.userId, shy));
    expect(row.lastSeenAt?.getTime()).toBe(t0.getTime());
  });
});

describe("notification level", () => {
  it("mutes per member and community", async () => {
    expect((await getCommunityView(shy, communityId)).notifications).toBe("mentions");
    await setNotificationLevel(shy, communityId, "muted");
    expect((await getCommunityView(shy, communityId)).notifications).toBe("muted");
    expect(await mutedCommunities(shy, [communityId])).toEqual(new Set([communityId]));
    expect(await mutedCommunities(social, [communityId])).toEqual(new Set());
    await expect(setNotificationLevel(shy, communityId, "everything")).rejects.toThrow();
    await expect(setNotificationLevel(outsider, communityId, "muted")).rejects.toThrow("Community not found.");
  });
});
