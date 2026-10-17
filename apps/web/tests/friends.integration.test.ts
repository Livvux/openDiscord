// Requires a migrated database at DATABASE_URL.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { dmConversation, userPresence } from "@/db/schema";
import { blockUser, unblockUser } from "@/server/blocks";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { createDirectConversation, respondToDirectRequest } from "@/server/direct-messages";
import { listFriends, removeFriend, respondToFriendRequest, searchPeople, sendFriendRequest } from "@/server/friends";
import { setPresenceStatus } from "@/server/presence";
import { getProfile, updateProfile } from "@/server/profile";
import { testUsers } from "./helpers";

const users = testUsers();
let ada: string, bo: string, cy: string, stranger: string;

beforeAll(async () => {
  [ada, bo, cy, stranger] = await Promise.all(["Ada Friend", "Bo Friend", "Cy Friend", "Stranger Danger"].map(users.create));
  const { communityId } = await createCommunity(ada, "Friends");
  for (const u of [bo, cy]) await acceptInvite(u, await createInvite(ada, communityId, { expiresInHours: 24, maxUses: 1 }));
});
afterAll(() => users.cleanup());

describe("friends", () => {
  it("sends, lists both directions, and accepts", async () => {
    expect(await sendFriendRequest(ada, bo)).toBe("sent");
    expect(await sendFriendRequest(ada, bo)).toBe("already");
    expect((await listFriends(ada)).map((f) => [f.id, f.state])).toEqual([[bo, "outgoing"]]);
    expect((await listFriends(bo)).map((f) => [f.id, f.state])).toEqual([[ada, "incoming"]]);
    await expect(respondToFriendRequest(ada, bo, true)).rejects.toThrow("no longer pending");
    await respondToFriendRequest(bo, ada, true);
    expect((await listFriends(ada))[0].state).toBe("friend");
  });

  it("accepts a crossing request instead of duplicating it", async () => {
    expect(await sendFriendRequest(cy, ada)).toBe("sent");
    expect(await sendFriendRequest(ada, cy)).toBe("accepted");
    await removeFriend(cy, ada);
    expect((await listFriends(ada)).map((f) => f.id)).toEqual([bo]);
  });

  it("declines and cancels quietly", async () => {
    await sendFriendRequest(cy, bo);
    await respondToFriendRequest(bo, cy, false);
    expect(await listFriends(cy)).toEqual([]);
    await sendFriendRequest(cy, bo);
    await removeFriend(cy, bo);
    expect(await listFriends(bo)).toEqual([expect.objectContaining({ id: ada })]);
  });

  it("works by friend code without a shared community, and the recipient can block the sender", async () => {
    await expect(sendFriendRequest(ada, ada)).rejects.toThrow("own friend code");
    await expect(sendFriendRequest(ada, "no-such-account")).rejects.toThrow("No account found");
    expect(await sendFriendRequest(stranger, cy)).toBe("sent");
    await blockUser(cy, stranger);
    expect(await listFriends(cy)).toEqual([]);
    await expect(sendFriendRequest(stranger, cy)).rejects.toThrow("No account found");
    await unblockUser(cy, stranger);
  });

  it("blocking ends a friendship", async () => {
    await sendFriendRequest(cy, ada);
    await respondToFriendRequest(ada, cy, true);
    await blockUser(ada, cy);
    expect((await listFriends(cy)).map((f) => f.id)).not.toContain(ada);
    await unblockUser(ada, cy);
  });

  it("finds only people from shared communities, never blocked ones", async () => {
    expect((await searchPeople(ada, "friend")).map((p) => [p.name, p.relation])).toEqual([["Bo Friend", "friend"], ["Cy Friend", null]]);
    expect(await searchPeople(ada, "danger")).toEqual([]);
    await blockUser(cy, ada);
    expect((await searchPeople(ada, "friend")).map((p) => p.name)).toEqual(["Bo Friend"]);
    await unblockUser(cy, ada);
    await expect(searchPeople(ada, "x")).rejects.toThrow("at least 2");
    expect(await searchPeople(ada, "%%")).toEqual([]);
  });

  it("lets friends open an encrypted DM without a message request", async () => {
    await sendFriendRequest(stranger, ada);
    await respondToFriendRequest(ada, stranger, true);
    const id = await createDirectConversation(stranger, ada);
    const [row] = await db.select({ status: dmConversation.status }).from(dmConversation).where(and(eq(dmConversation.id, id)));
    expect(row.status).toBe("accepted");
  });

  it("becoming friends accepts an earlier message request, even a declined one", async () => {
    const id = await createDirectConversation(bo, cy);
    await respondToDirectRequest(cy, id, "rejected");
    await sendFriendRequest(bo, cy);
    await respondToFriendRequest(cy, bo, true);
    const [row] = await db.select({ status: dmConversation.status }).from(dmConversation).where(eq(dmConversation.id, id));
    expect(row.status).toBe("accepted");
    await removeFriend(bo, cy);
  });

  it("shows friends' presence, status and bio only once accepted", async () => {
    await updateProfile(bo, { bio: "Hello there", customStatus: "Building" });
    await setPresenceStatus(bo, "dnd");
    await db.update(userPresence).set({ lastSeenAt: new Date() }).where(eq(userPresence.userId, bo));
    const [friend] = (await listFriends(ada)).filter((f) => f.id === bo);
    expect(friend).toMatchObject({ presence: "dnd", customStatus: "Building", bio: "Hello there" });
    await setPresenceStatus(bo, "invisible");
    expect((await listFriends(ada)).find((f) => f.id === bo)?.presence).toBeNull();
  });
});

describe("profile", () => {
  it("validates length and control characters", async () => {
    await expect(updateProfile(ada, { bio: "x".repeat(191), customStatus: "" })).rejects.toThrow("190");
    await expect(updateProfile(ada, { bio: "", customStatus: "two\nlines" })).rejects.toThrow("single line");
    await expect(updateProfile(ada, { bio: "", customStatus: "evil\u202Etxt" })).rejects.toThrow("single line");
    await updateProfile(ada, { bio: " multi\nline ", customStatus: " ok " });
    expect(await getProfile(ada)).toEqual({ bio: "multi\nline", customStatus: "ok" });
  });
});
