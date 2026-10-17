// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blockUser } from "@/server/blocks";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { sendFriendRequest } from "@/server/friends";
import { getProfileCard } from "@/server/profile-card";
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
    await sendFriendRequest(ada, bo);
    expect((await getProfileCard(bo, ada)).relation).toBe("incoming");
  });

  it("hides accounts with no shared context and strips profile text from blocked pairs", async () => {
    await expect(getProfileCard(stranger, bo)).rejects.toThrow("Profile not found.");
    await expect(getProfileCard(ada, "x".repeat(65))).rejects.toThrow();
    await blockUser(bo, ada);
    const card = await getProfileCard(ada, bo);
    expect(card).toMatchObject({ bio: "", customStatus: "", presence: null, mutualCommunities: [], blocked: false });
    expect((await getProfileCard(bo, ada)).blocked).toBe(true);
  });
});
