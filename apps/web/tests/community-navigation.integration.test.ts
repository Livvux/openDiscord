import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, createCommunity, createInvite, listCommunityNavigation } from "@/server/communities";
import { createRole, setMemberRole } from "@/server/moderation";
import { ALL_PERMISSIONS, DEFAULT_MEMBER_PERMISSIONS, OWNER_RANK, Permission } from "@/server/permissions";
import { setNotificationLevel } from "@/server/presence";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string, moderator: string, outsider: string;
let communityId: string;

beforeAll(async () => {
  [owner, member, moderator, outsider] = await Promise.all(["Owner", "Member", "Moderator", "Outsider"].map(users.create));
  ({ communityId } = await createCommunity(owner, "Server menu"));
  await createCommunity(owner, "Owner only");
  const code = await createInvite(owner, communityId, { expiresInHours: 24, maxUses: null });
  await acceptInvite(member, code);
  await acceptInvite(moderator, code);
  const roleId = await createRole(owner, communityId, "Managers", ["ManageCommunity"]);
  await setMemberRole(owner, roleId, moderator, true);
  await setNotificationLevel(member, communityId, "muted");
});

afterAll(() => users.cleanup());

describe("server navigation metadata", () => {
  it("includes ownership permissions and only communities the viewer joined", async () => {
    const owned = await listCommunityNavigation(owner);
    expect(owned).toHaveLength(2);
    for (const entry of owned) {
      expect(entry.authority).toEqual({ isOwner: true, permissions: ALL_PERMISSIONS, rank: OWNER_RANK });
      expect(entry.notifications).toBe("mentions");
    }
    expect(await listCommunityNavigation(outsider)).toEqual([]);
  });

  it("does not give ordinary members another person's assigned management permissions", async () => {
    expect(await listCommunityNavigation(member)).toEqual([{
      id: communityId,
      name: "Server menu",
      iconId: null,
      verified: false,
      notifications: "muted",
      authority: { isOwner: false, permissions: DEFAULT_MEMBER_PERMISSIONS, rank: 0 },
    }]);
    const [entry] = await listCommunityNavigation(moderator);
    expect(entry.authority).toEqual({
      isOwner: false,
      permissions: DEFAULT_MEMBER_PERMISSIONS | Permission.ManageCommunity,
      rank: 1,
    });
    expect(entry.notifications).toBe("mentions");
  });
});
