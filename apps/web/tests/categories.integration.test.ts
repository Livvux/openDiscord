// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCategory, deleteCategory, MAX_CATEGORIES, renameCategory, setChannelCategory } from "@/server/categories";
import { acceptInvite, createChannel, createCommunity, createInvite, getCommunityView, setChannelOverride } from "@/server/communities";
import { listAuditLog, listRoles } from "@/server/moderation";
import { Permission } from "@/server/permissions";
import { db } from "@/db";
import { category } from "@/db/schema";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string;
let communityId: string, generalId: string;

beforeAll(async () => {
  [owner, member] = await Promise.all(["Owner", "Member"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "Grouped"));
  await acceptInvite(member, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
});
afterAll(() => users.cleanup());

describe("categories", () => {
  it("groups channels, in creation order, managed with Manage channels only", async () => {
    await expect(createCategory(member, communityId, "Nope")).rejects.toThrow("permission");
    const projects = await createCategory(owner, communityId, " Projects ");
    const social = await createCategory(owner, communityId, "Social");
    await setChannelCategory(owner, generalId, social);
    const view = await getCommunityView(member, communityId);
    expect(view.categories).toEqual([{ id: projects, name: "Projects" }, { id: social, name: "Social" }]);
    expect(view.channels.find((c) => c.id === generalId)?.categoryId).toBe(social);
    await expect(setChannelCategory(member, generalId, null)).rejects.toThrow("permission");
    await renameCategory(owner, projects, "Work");
    expect((await getCommunityView(member, communityId)).categories[0].name).toBe("Work");
  });

  it("refuses categories from another community and unknown ones", async () => {
    const other = await createCommunity(owner, "Other");
    const foreign = await createCategory(owner, other.communityId, "Foreign");
    await expect(setChannelCategory(owner, generalId, foreign)).rejects.toThrow("Category not found.");
  });

  it("keeps channels when a category is deleted, audited", async () => {
    const temp = await createCategory(owner, communityId, "Temp");
    const ch = await createChannel(owner, communityId, "inside");
    await setChannelCategory(owner, ch, temp);
    await deleteCategory(owner, temp);
    expect((await getCommunityView(owner, communityId)).channels.find((c) => c.id === ch)?.categoryId).toBeNull();
    expect((await listAuditLog(owner, communityId)).map((e) => e.action)).toContain("category.delete");
  });

  it("doesn't reveal hidden channels through categories", async () => {
    const staff = await createCategory(owner, communityId, "Staff");
    const hidden = await createChannel(owner, communityId, "mods");
    await setChannelCategory(owner, hidden, staff);
    const everyone = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
    await setChannelOverride(owner, hidden, everyone, 0, Permission.ViewChannels);
    const view = await getCommunityView(member, communityId);
    expect(view.channels.some((c) => c.categoryId === staff)).toBe(false);
  });

  it("caps categories per community", async () => {
    const { communityId: full } = await createCommunity(owner, "Full");
    await db.insert(category).values(Array.from({ length: MAX_CATEGORIES }, (_, i) => ({ communityId: full, name: `c${i}` })));
    await expect(createCategory(owner, full, "one more")).rejects.toThrow("at most");
  });
});
