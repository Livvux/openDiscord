// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { applicationRateLimit, userSuspension } from "@/db/schema";
import { blockUser } from "@/server/blocks";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { sendFriendRequest } from "@/server/friends";
import { getProfileCard, PROFILE_CARD_LIMIT } from "@/server/profile-card";
import { hashRateLimitKey } from "@/server/rate-limit-store";
import { updateProfile } from "@/server/profile";
import { testUsers } from "./helpers";

const users = testUsers();
let ada: string, bo: string, stranger: string, communityId: string;

beforeAll(async () => {
  [ada, bo, stranger] = await Promise.all(["Ada Card", "Bo Card", "Stranger Card"].map(users.create));
  ({ communityId } = await createCommunity(ada, "Card Club"));
  await acceptInvite(bo, await createInvite(ada, communityId, { expiresInHours: 24, maxUses: 1 }));
  await updateProfile(bo, { bio: "Hello there", customStatus: "Coding" });
});
afterAll(() => users.cleanup());

describe("profile card", () => {
  it("shows profile, relation and mutual communities to people who share a community", async () => {
    const card = await getProfileCard(ada, bo);
    expect(card).toMatchObject({ id: bo, name: "Bo Card", bio: "Hello there", customStatus: "Coding", relation: null, blocked: false });
    expect(card.mutualCommunities).toEqual([{ id: communityId, name: "Card Club" }]);
    expect(card.badges).not.toContain("community_founder");
    expect((await getProfileCard(bo, ada)).badges).toContain("community_founder");
    await sendFriendRequest(ada, bo);
    expect((await getProfileCard(bo, ada)).relation).toBe("incoming");
  });

  it("hides accounts with no shared context and strips profile text from blocked pairs", async () => {
    await expect(getProfileCard(stranger, bo)).rejects.toThrow("Profile not found.");
    await expect(getProfileCard(ada, "x".repeat(65))).rejects.toThrow();
    await blockUser(bo, ada);
    const card = await getProfileCard(ada, bo);
    expect(card).toMatchObject({ bio: "", customStatus: "", presence: null, mutualCommunities: [], badges: [], blocked: false });
    expect((await getProfileCard(bo, ada)).blocked).toBe(true);
  });

  it("hides suspended accounts but still shows your own card", async () => {
    await db.insert(userSuspension).values({ userId: bo, reason: "profile card test" });
    await expect(getProfileCard(ada, bo)).rejects.toThrow("Profile not found.");
    await expect(getProfileCard(bo, bo)).resolves.toMatchObject({ id: bo });
    await db.delete(userSuspension).where(eq(userSuspension.userId, bo));
  });

  it("has its own rate-limit bucket", async () => {
    await db.delete(applicationRateLimit).where(eq(applicationRateLimit.key, hashRateLimitKey(`profile-card:${ada}`)));
    for (let i = 0; i < PROFILE_CARD_LIMIT.max; i++) await getProfileCard(ada, ada);
    await expect(getProfileCard(ada, ada)).rejects.toThrow("too often");
  });
});
