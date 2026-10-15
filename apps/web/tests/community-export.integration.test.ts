// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCategory, setChannelCategory } from "@/server/categories";
import { exportCommunity, importCommunity, type CommunityExport } from "@/server/community-export";
import { acceptInvite, createChannel, createCommunity, createInvite, getCommunityView, listChannelOverrides, setChannelOverride } from "@/server/communities";
import { editMessage, listMessages, listPinned, sendMessage, setPinned } from "@/server/messages";
import { createRole, listAuditLog, listRoles } from "@/server/moderation";
import { Permission } from "@/server/permissions";
import { getCommunityRules, updateCommunityRules } from "@/server/community-trust";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string, importer: string;
let communityId: string, generalId: string;
let exported: CommunityExport;

beforeAll(async () => {
  [owner, member, importer] = await Promise.all(["Owner", "Mia", "Importer"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "Moving Out"));
  await acceptInvite(member, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
  const mods = await createRole(owner, communityId, "mods", ["ManageMessages", "ViewChannels", "SendMessages"]);
  const everyone = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
  const cat = await createCategory(owner, communityId, "Staff");
  const staff = await createChannel(owner, communityId, "staff-room");
  await setChannelCategory(owner, staff, cat);
  await setChannelOverride(owner, staff, everyone, 0, Permission.ViewChannels);
  await setChannelOverride(owner, staff, mods, Permission.ViewChannels, 0);
  const root = await sendMessage(member, generalId, `hello <@${owner}>`);
  await sendMessage(owner, generalId, "welcome!", [], root.id);
  await sendMessage(owner, generalId, "thread reply", [], null, root.id);
  await setPinned(owner, root.id, true);
  await updateCommunityRules(owner, communityId, { text: "Respect the community.", required: true });
});
afterAll(() => users.cleanup());

describe("community export", () => {
  it("is owner-only and audited", async () => {
    await expect(exportCommunity(member, communityId)).rejects.toThrow("Only the owner");
    exported = await exportCommunity(owner, communityId);
    expect((await listAuditLog(owner, communityId)).map((e) => e.action)).toContain("community.export");
  });

  it("contains structure and messages, with mentions as plain names and no account ids", () => {
    expect(exported.community.name).toBe("Moving Out");
    expect(exported.community).toMatchObject({ rules: "Respect the community.", rulesRequired: true });
    expect(exported.channels.map((c) => c.name)).toEqual(["general", "staff-room"]);
    expect(exported.messages.map((m) => [m.author, m.content])).toEqual([
      ["Mia", "hello @Owner"],
      ["Owner", "welcome!"],
      ["Owner", "thread reply"],
    ]);
    expect(JSON.stringify(exported)).not.toContain(owner);
    expect(JSON.stringify(exported)).not.toContain(member);
  });
});

describe("community import", () => {
  let imported: string;

  it("accepts older version-one exports without rules", async () => {
    const id = await importCommunity(importer, { ...exported, community: { name: "Legacy rules" } });
    expect(await getCommunityRules(importer, id)).toMatchObject({ text: "", required: false });
  });

  it("rebuilds roles, categories, channels, overrides and messages for the importer", async () => {
    imported = await importCommunity(importer, exported);
    const view = await getCommunityView(importer, imported);
    expect(view.isOwner).toBe(true);
    expect(await getCommunityRules(importer, imported)).toMatchObject({ text: "Respect the community.", required: true, accepted: true });
    expect(view.categories.map((c) => c.name)).toEqual(["Staff"]);
    const staff = view.channels.find((c) => c.name === "staff-room")!;
    expect(staff.categoryId).toBe(view.categories[0].id);
    expect(staff.isPrivate).toBe(true);
    const roles = await listRoles(importer, imported);
    expect(roles.map((r) => r.name)).toEqual(["mods", "everyone"]);
    const overrides = await listChannelOverrides(importer, staff.id);
    expect(overrides.find((o) => o.roleName === "mods")?.allow).toBe(Permission.ViewChannels);

    const general = view.channels.find((c) => c.name === "general")!;
    const page = await listMessages(importer, general.id);
    expect(page.messages.map((m) => [m.authorName, m.content, m.authorImported])).toEqual([
      ["Mia", "hello @Owner", true],
      ["Owner", "welcome!", true],
    ]);
    expect(page.messages[1].replyTo).toMatchObject({ authorName: "Mia", authorImported: true });
    expect(page.messages[0].thread?.count).toBe(1);
    expect((await listPinned(importer, general.id)).map((m) => m.content)).toEqual(["hello @Owner"]);
    await expect(editMessage(importer, page.messages[0].id, "rewritten")).rejects.toThrow("can't be edited");
  });

  it("clamps impossible times and merges duplicate overrides", async () => {
    const forged = structuredClone(exported);
    forged.messages[0].createdAt = "2999-01-01T00:00:00.000Z";
    forged.messages[1].createdAt = "1900-01-01T00:00:00.000Z";
    const staff = forged.channels.find((c) => c.name === "staff-room")!;
    staff.overrides.push({ ...staff.overrides[0] });
    const id = await importCommunity(importer, forged);
    const general = (await getCommunityView(importer, id)).channels.find((c) => c.name === "general")!;
    const times = (await listMessages(importer, general.id)).messages.map((m) => Date.parse(m.createdAt));
    expect(times.every((t) => t <= Date.now() && t >= Date.parse("2015-01-01"))).toBe(true);
  });

  it("refuses duplicate message keys", async () => {
    await expect(importCommunity(importer, { ...exported, messages: [exported.messages[0], exported.messages[0]] })).rejects.toThrow("duplicate");
  });

  it("refuses files that aren't valid exports", async () => {
    await expect(importCommunity(importer, { format: "something-else" })).rejects.toThrow();
    await expect(importCommunity(importer, { ...exported, messages: [{ ...exported.messages[0], channelKey: "missing" }] })).rejects.toThrow("doesn't contain");
    await expect(importCommunity(importer, { ...exported, channels: [] })).rejects.toThrow();
  });
});
