// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { loadChannelAuthority } from "@/server/access";
import { createCategory, deleteCategory, listCategoryOverrides, setCategoryOverride, setChannelCategory } from "@/server/categories";
import { acceptInvite, createChannel, createCommunity, createInvite, getCommunityView, setChannelOverride } from "@/server/communities";
import { exportCommunity } from "@/server/community-export";
import { createRole, listRoles, setMemberRole } from "@/server/moderation";
import { inheritOverrides, Permission } from "@/server/permissions";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, staff: string, member: string, channelMod: string, lowMod: string;
let communityId: string, everyoneRole: string, staffRole: string;

beforeAll(async () => {
  [owner, staff, member, channelMod, lowMod] = await Promise.all(["Owner", "Staff", "Member", "ChannelMod", "LowMod"].map(users.create));
  ({ communityId } = await createCommunity(owner, "Category permissions"));
  for (const u of [staff, member, channelMod, lowMod]) await acceptInvite(u, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
  staffRole = await createRole(owner, communityId, "staff", []);
  const channelRole = await createRole(owner, communityId, "channels", ["ManageChannels", "ViewChannels", "SendMessages"]);
  const lowRole = await createRole(owner, communityId, "low", ["ManageChannels", "ManageRoles", "ViewChannels", "SendMessages"]);
  await setMemberRole(owner, staffRole, staff, true);
  await setMemberRole(owner, channelRole, channelMod, true);
  await setMemberRole(owner, lowRole, lowMod, true);
  everyoneRole = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
});
afterAll(() => users.cleanup());

const sees = async (u: string, channelId: string) => (await loadChannelAuthority(db, channelId, u)) !== null;

describe("inheritOverrides", () => {
  it("lets a channel's own override replace its category's for the same role only", () => {
    const merged = inheritOverrides(
      [{ roleId: "a", allow: Permission.ViewChannels, deny: 0 }],
      [{ roleId: "a", allow: 0, deny: Permission.ViewChannels }, { roleId: "b", allow: 0, deny: Permission.SendMessages }],
    );
    expect(merged).toEqual([{ roleId: "a", allow: Permission.ViewChannels, deny: 0 }, { roleId: "b", allow: 0, deny: Permission.SendMessages }]);
  });
});

describe("category overrides", () => {
  it("make every channel in the category private, and channels inherit only while they belong to it", async () => {
    const categoryId = await createCategory(owner, communityId, "Staff area");
    const channelId = await createChannel(owner, communityId, "staff-notes");
    await setChannelCategory(owner, channelId, categoryId);
    await setCategoryOverride(owner, categoryId, everyoneRole, 0, Permission.ViewChannels);
    await setCategoryOverride(owner, categoryId, staffRole, Permission.ViewChannels, 0);

    expect(await sees(member, channelId)).toBe(false);
    expect(await sees(staff, channelId)).toBe(true);
    expect((await getCommunityView(staff, communityId)).channels.find((c) => c.id === channelId)?.isPrivate).toBe(true);
    expect((await listCategoryOverrides(owner, categoryId)).find((r) => r.isDefault)?.deny).toBe(Permission.ViewChannels);

    // A channel override for the same role wins over the category.
    await setChannelOverride(owner, channelId, everyoneRole, Permission.ViewChannels, 0);
    expect(await sees(member, channelId)).toBe(true);
    await setChannelOverride(owner, channelId, everyoneRole, 0, 0);
    expect(await sees(member, channelId)).toBe(false);

    await setChannelCategory(owner, channelId, null);
    expect(await sees(member, channelId)).toBe(true);
  });

  it("needs role management to move channels across categories with overrides or to delete such a category", async () => {
    const categoryId = await createCategory(owner, communityId, "Locked");
    const channelId = await createChannel(owner, communityId, "locked-room");
    await setChannelCategory(owner, channelId, categoryId);
    await setCategoryOverride(owner, categoryId, everyoneRole, 0, Permission.SendMessages);

    await expect(setChannelCategory(channelMod, channelId, null)).rejects.toThrow();
    await expect(deleteCategory(channelMod, categoryId)).rejects.toThrow();
    await expect(setCategoryOverride(channelMod, categoryId, everyoneRole, 0, 0)).rejects.toThrow();
    await expect(listCategoryOverrides(channelMod, categoryId)).rejects.toThrow();

    // Plain categories stay manageable with Manage channels alone.
    const plain = await createCategory(owner, communityId, "Plain");
    const other = await createChannel(owner, communityId, "plain-room");
    await setChannelCategory(channelMod, other, plain);
    await deleteCategory(channelMod, plain);
  });

  it("does not let a manager reach channels in the category they cannot see", async () => {
    const categoryId = await createCategory(owner, communityId, "Hidden");
    const channelId = await createChannel(owner, communityId, "hidden-room");
    await setChannelCategory(owner, channelId, categoryId);
    await setChannelOverride(owner, channelId, everyoneRole, 0, Permission.ViewChannels);
    // lowMod outranks staff and holds Manage roles, but cannot see hidden-room: the category is off limits.
    await expect(setCategoryOverride(lowMod, categoryId, staffRole, Permission.ViewChannels, 0)).rejects.toThrow();
    await setCategoryOverride(owner, categoryId, staffRole, 0, Permission.SendMessages);
    await expect(deleteCategory(lowMod, categoryId)).rejects.toThrow();
    await setCategoryOverride(owner, categoryId, staffRole, 0, 0);
    await expect(deleteCategory(lowMod, categoryId)).resolves.toBeUndefined();
    expect(await sees(lowMod, channelId)).toBe(false);
  });

  it("travels with a community export", async () => {
    const categoryId = await createCategory(owner, communityId, "Exported");
    await setCategoryOverride(owner, categoryId, everyoneRole, 0, Permission.ViewChannels);
    const data = await exportCommunity(owner, communityId, false);
    expect(data.categories.find((c) => c.name === "Exported")?.overrides).toEqual([{ roleKey: everyoneRole, allow: 0, deny: Permission.ViewChannels }]);
  });
});
