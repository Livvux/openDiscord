// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { loadChannelAuthority } from "@/server/access";
import {
  acceptInvite,
  createChannel,
  createCommunity,
  createInvite,
  deleteChannel,
  getCommunityView,
  listChannelOverrides,
  setChannelOverride,
  updateChannel,
} from "@/server/communities";
import { deleteMessage, listMessages, sendMessage } from "@/server/messages";
import { createRole, listAuditLog, listRoles, setMemberRole } from "@/server/moderation";
import { Permission } from "@/server/permissions";
import { reportContent } from "@/server/reports";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, staff: string, member: string, mod: string;
let communityId: string, privateId: string, everyoneRole: string, staffRole: string, modRole: string;

beforeAll(async () => {
  [owner, staff, member, mod] = await Promise.all(["Owner", "Staff", "Member", "Mod"].map(users.create));
  ({ communityId } = await createCommunity(owner, "Permissions"));
  for (const u of [staff, member, mod]) await acceptInvite(u, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
  staffRole = await createRole(owner, communityId, "staff", []);
  modRole = await createRole(owner, communityId, "mod", ["ManageChannels", "ManageRoles", "ViewChannels", "SendMessages"]);
  await setMemberRole(owner, staffRole, staff, true);
  await setMemberRole(owner, modRole, mod, true);
  everyoneRole = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
  privateId = await createChannel(owner, communityId, "staff-only");
  await setChannelOverride(owner, privateId, everyoneRole, 0, Permission.ViewChannels);
  await setChannelOverride(owner, privateId, staffRole, Permission.ViewChannels, 0);
});
afterAll(() => users.cleanup());

describe("private channels", () => {
  it("lists the channel only for roles allowed to view it", async () => {
    const names = async (u: string) => (await getCommunityView(u, communityId)).channels.map((c) => c.name);
    expect(await names(staff)).toContain("staff-only");
    expect(await names(owner)).toContain("staff-only");
    expect(await names(member)).not.toContain("staff-only");
    const view = await getCommunityView(staff, communityId);
    expect(view.channels.find((c) => c.id === privateId)?.isPrivate).toBe(true);
  });

  it("treats hidden channels as not found for reading, sending, reporting and realtime", async () => {
    const sent = await sendMessage(staff, privateId, "secret plans");
    await expect(listMessages(member, privateId)).rejects.toThrow("Channel not found.");
    await expect(sendMessage(member, privateId, "hi")).rejects.toThrow("Channel not found.");
    await expect(deleteMessage(member, sent.id)).rejects.toThrow("Channel not found.");
    await expect(reportContent(member, { messageId: sent.id, reason: "guessing ids" })).rejects.toThrow("Channel not found.");
    // The SSE stream forwards channel events only when this returns access.
    expect(await loadChannelAuthority(db, privateId, member)).toBeNull();
    expect(await loadChannelAuthority(db, privateId, staff)).not.toBeNull();
  });

  it("supports read-only channels through a send deny", async () => {
    const announcements = await createChannel(owner, communityId, "announcements");
    await setChannelOverride(owner, announcements, everyoneRole, 0, Permission.SendMessages);
    await expect(sendMessage(member, announcements, "hello")).rejects.toThrow("permission");
    expect((await listMessages(member, announcements)).messages).toEqual([]);
    await setChannelOverride(owner, announcements, staffRole, Permission.SendMessages, 0);
    await expect(sendMessage(staff, announcements, "news")).resolves.toMatchObject({ content: "news" });
  });

  it("resets an override when both bit sets are empty", async () => {
    const temp = await createChannel(owner, communityId, "temp");
    await setChannelOverride(owner, temp, everyoneRole, 0, Permission.ViewChannels);
    await setChannelOverride(owner, temp, everyoneRole, 0, 0);
    expect((await listChannelOverrides(owner, temp)).find((o) => o.roleId === everyoneRole)).toMatchObject({ allow: 0, deny: 0 });
    expect((await getCommunityView(member, communityId)).channels.map((c) => c.name)).toContain("temp");
  });
});

describe("override escalation rules", () => {
  let openId: string;
  beforeAll(async () => {
    openId = await createChannel(owner, communityId, "lounge");
  });

  it("requires both channel and role management", async () => {
    await expect(setChannelOverride(member, openId, everyoneRole, 0, 0)).rejects.toThrow("permission");
    await expect(listChannelOverrides(staff, openId)).rejects.toThrow("permission");
  });

  it("only allows overrides for roles below the actor and with bits the actor holds", async () => {
    // The owner created mod after staff, so mod sits above staff.
    await expect(setChannelOverride(mod, openId, staffRole, Permission.ViewChannels, 0)).resolves.toBeUndefined();
    await expect(setChannelOverride(mod, openId, modRole, Permission.ViewChannels, 0)).rejects.toThrow("permission");
    // mod lacks ManageMessages, so can't grant it anywhere.
    await expect(setChannelOverride(mod, openId, staffRole, Permission.ManageMessages, 0)).rejects.toThrow("permission");
  });

  it("keeps managers who are excluded from a channel out of it", async () => {
    const vault = await createChannel(owner, communityId, "vault");
    await setChannelOverride(owner, vault, everyoneRole, 0, Permission.ViewChannels);
    // mod manages channels and roles and holds a lower role (staff) it could otherwise unlock.
    await setMemberRole(owner, staffRole, mod, true);
    await expect(setChannelOverride(mod, vault, staffRole, Permission.ViewChannels, 0)).rejects.toThrow("Channel not found.");
    await expect(listChannelOverrides(mod, vault)).rejects.toThrow("Channel not found.");
    await expect(updateChannel(mod, vault, "renamed", "")).rejects.toThrow("Channel not found.");
    await expect(deleteChannel(mod, vault)).rejects.toThrow("Channel not found.");
    await setMemberRole(owner, staffRole, mod, false);
  });

  it("keeps private channel names out of the audit log", async () => {
    const log = await listAuditLog(owner, communityId);
    expect(log.filter((e) => e.action === "channel.permissions").map((e) => e.targetId)).not.toContain("vault");
  });

  it("rejects bits that aren't channel permissions and contradictory overrides", async () => {
    await expect(setChannelOverride(owner, privateId, staffRole, Permission.BanMembers, 0)).rejects.toThrow();
    await expect(setChannelOverride(owner, privateId, staffRole, Permission.SendMessages, Permission.SendMessages)).rejects.toThrow("both");
  });

  it("refuses roles from another community", async () => {
    const other = await createCommunity(owner, "Elsewhere");
    const foreignRole = (await listRoles(owner, other.communityId)).find((r) => r.isDefault)!.id;
    await expect(setChannelOverride(owner, privateId, foreignRole, 0, Permission.ViewChannels)).rejects.toThrow("Role not found.");
  });
});
