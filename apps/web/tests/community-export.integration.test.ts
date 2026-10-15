// Requires a migrated database at DATABASE_URL.
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachment, community, instanceSettings, session, user, userSuspension } from "@/db/schema";
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
const stagedIds: string[] = [];
afterAll(async () => {
  if (stagedIds.length) await db.delete(attachment).where(inArray(attachment.id, stagedIds));
  await users.cleanup();
});

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


describe("private archive staging commit", () => {
  async function fixture() {
    const id = await users.create("Archive importer");
    const sessionId = randomUUID();
    await db.insert(session).values({ id: sessionId, userId: id, token: randomUUID(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    const data = { ...exported, messages: exported.messages.map((m, index) => ({ ...m, attachments: index === 0 ? 1 : 0 })) };
    return { id, sessionId, data };
  }
  async function staged(uploaderId: string) {
    const [row] = await db.insert(attachment).values({ uploaderId, key: `attachments/${randomUUID()}.bin`, contentType: "application/octet-stream", filename: "private.bin", size: 3, width: 0, height: 0 }).returning({ id: attachment.id });
    stagedIds.push(row.id);
    return row.id;
  }
  it("atomically links owned staged files without a missing-file note", async () => {
    const { id, sessionId, data } = await fixture();
    const file = await staged(id);
    await importCommunity(id, data, { sessionId, attachments: [{ id: file, messageKey: data.messages[0].key }] });
    const [linked] = await db.select().from(attachment).where(eq(attachment.id, file));
    expect(linked.messageId).not.toBeNull(); expect(linked.channelId).not.toBeNull(); expect(linked.linkedAt).not.toBeNull();
    const messages = await listMessages(id, linked.channelId);
    expect(messages.messages.some((m) => m.content.includes("attachment not imported"))).toBe(false);
  });
  it("rejects foreign staged IDs and rolls back the new community", async () => {
    const { id, sessionId, data } = await fixture();
    const file = await staged(owner);
    await expect(importCommunity(id, data, { sessionId, attachments: [{ id: file, messageKey: data.messages[0].key }] })).rejects.toThrow("no longer available");
    expect(await db.select().from(community).where(eq(community.ownerId, id))).toHaveLength(0);
    expect((await db.select().from(attachment).where(eq(attachment.id, file)))[0].messageId).toBeNull();
  });
  it("rejects a revoked session before creating the community", async () => {
    const { id, sessionId, data } = await fixture();
    const file = await staged(id);
    await db.delete(session).where(eq(session.id, sessionId));
    await expect(importCommunity(id, data, { sessionId, attachments: [{ id: file, messageKey: data.messages[0].key }] })).rejects.toThrow("Sign in again");
    expect(await db.select().from(community).where(eq(community.ownerId, id))).toHaveLength(0);
  });
  it.each(["revoke", "suspend"])("rechecks %s after waiting for the importing user lock", async (change) => {
    const { id, sessionId, data } = await fixture();
    const file = await staged(id);
    const holder: { pending?: Promise<PromiseSettledResult<string>> } = {};
    await db.transaction(async (tx) => {
      await tx.select({ id: user.id }).from(user).where(eq(user.id, id)).for("update");
      holder.pending = importCommunity(id, data, { sessionId, attachments: [{ id: file, messageKey: data.messages[0].key }] }).then(
        (value): PromiseSettledResult<string> => ({ status: "fulfilled", value }),
        (reason: unknown): PromiseSettledResult<string> => ({ status: "rejected", reason }),
      );
      await expect.poll(async () => (await db.execute<{ waiting: boolean }>(sql`
        select exists(select 1 from pg_stat_activity where wait_event_type = 'Lock'
          and query like '%from "user"%for update%') as waiting
      `)).rows[0]?.waiting).toBe(true);
      if (change === "revoke") await tx.delete(session).where(eq(session.id, sessionId));
      else await tx.insert(userSuspension).values({ userId: id, reason: "Concurrent suspension" });
    });
    if (!holder.pending) throw new Error("Import was not started");
    const result = await holder.pending;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: change === "revoke" ? "unauthorized" : "forbidden" });
    expect(await db.select().from(community).where(eq(community.ownerId, id))).toHaveLength(0);
  });
  it("serializes the owned-community cap with a concurrent normal create", async () => {
    const { id, data } = await fixture();
    const [previous] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, "instance"));
    await db.insert(instanceSettings).values({ id: "instance", ownedCommunities: 1 }).onConflictDoUpdate({ target: instanceSettings.id, set: { ownedCommunities: 1 } });
    try {
      const results = await Promise.allSettled([createCommunity(id, "Concurrent create"), importCommunity(id, { ...data, messages: [] })]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) if (result.status === "rejected") expect(String(result.reason)).toContain("at most 1");
      expect(await db.select().from(community).where(eq(community.ownerId, id))).toHaveLength(1);
    } finally {
      if (previous) await db.update(instanceSettings).set({ ownedCommunities: previous.ownedCommunities }).where(eq(instanceSettings.id, "instance"));
      else await db.delete(instanceSettings).where(eq(instanceSettings.id, "instance"));
    }
  });
  it("rolls back all earlier link batches when a later staged file is foreign", async () => {
    const { id, sessionId, data } = await fixture();
    const rows = await db.insert(attachment).values(Array.from({ length: 1001 }, (_, index) => ({
      uploaderId: index === 1000 ? owner : id, key: `attachments/${randomUUID()}.bin`, contentType: "application/octet-stream", filename: "staged.bin", size: 1, width: 0, height: 0,
    }))).returning({ id: attachment.id, uploaderId: attachment.uploaderId });
    stagedIds.push(...rows.map((row) => row.id));
    const foreign = rows.find((row) => row.uploaderId === owner);
    if (!foreign) throw new Error("Foreign fixture missing");
    const ordered = [...rows.filter((row) => row.uploaderId === id), foreign];
    const messages = ordered.map((_, index) => ({ ...data.messages[0], key: `batch-${index}`, replyToKey: null, threadKey: null, attachments: 1 }));
    await expect(importCommunity(id, { ...data, messages }, { sessionId, attachments: ordered.map((row, index) => ({ id: row.id, messageKey: messages[index].key })) })).rejects.toThrow("no longer available");
    expect(await db.select().from(community).where(eq(community.ownerId, id))).toHaveLength(0);
    const unchanged = await db.select().from(attachment).where(inArray(attachment.id, ordered.map((row) => row.id)));
    expect(unchanged.every((row) => row.messageId === null && row.channelId === null && row.linkedAt === null)).toBe(true);
  });

});
