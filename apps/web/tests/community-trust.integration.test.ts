import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { banAppeal, community, member } from "@/db/schema";
import { lockCommunity } from "@/server/access";
import { acceptInvite, createCommunity, createInvite, getCommunityView, getInvitePreview, revokeInvite } from "@/server/communities";
import { acknowledgeCommunityRules, getCommunityRules, listBanAppeals, listOwnAppealHistory, listOwnRestrictions, resolveBanAppeal, submitBanAppeal, updateCommunityRules } from "@/server/community-trust";
import { sendMessage, toggleReaction } from "@/server/messages";
import { banMember, createRole, listAuditLog, setMemberRole, unbanMember } from "@/server/moderation";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, alice: string, bob: string, stranger: string;
let communityId: string, channelId: string, code: string;
beforeAll(async () => {
  [owner, alice, bob, stranger] = await Promise.all(["Trust owner", "Alice", "Bob", "Stranger"].map(users.create));
  ({ communityId, channelId } = await createCommunity(owner, "Trust"));
  code = await createInvite(owner, communityId, { expiresInHours: 24, maxUses: null });
  await acceptInvite(alice, code);
  await acceptInvite(bob, code);
});
afterAll(() => users.cleanup());

describe("community rules", () => {
  it("rechecks acknowledgement when a reaction waits behind a rules change", async () => {
    const group = await createCommunity(owner, "Reaction rules");
    const posted = await sendMessage(owner, group.channelId, "React to this");
    let attempt: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await lockCommunity(tx, group.communityId);
      await tx.update(community).set({ rules: "New required rules", rulesRequired: true, rulesVersion: 1 }).where(eq(community.id, group.communityId));
      attempt = toggleReaction(owner, posted.id, "👍").catch((error: unknown) => error);
      await vi.waitFor(async () => {
        const blocked = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
          where wait_event_type = 'Lock' and query like '%community%' and query like '%for update%'`);
        expect(blocked.rows[0].count).toBeGreaterThan(0);
      }, { timeout: 3000, interval: 20 });
    });
    expect(await attempt).toMatchObject({ message: expect.stringContaining("acknowledge") });
  });

  it("requires membership to read/acknowledge, management to edit, and bounds plain text", async () => {
    await expect(getCommunityRules(stranger, communityId)).rejects.toThrow("not found");
    await expect(acknowledgeCommunityRules(stranger, communityId, 0)).rejects.toThrow("not found");
    await expect(updateCommunityRules(alice, communityId, { text: "x", required: true })).rejects.toThrow("permission");
    await expect(updateCommunityRules(owner, communityId, { text: "x".repeat(4001), required: false })).rejects.toThrow();
    await expect(updateCommunityRules(owner, communityId, { text: "", required: true })).rejects.toThrow("Write rules");
    await updateCommunityRules(owner, communityId, { text: "Respect people. <script>alert(1)</script>", required: true });
    expect((await getCommunityRules(alice, communityId)).text).toContain("<script>");
    const revoked = await createInvite(owner, communityId, { expiresInHours: 24, maxUses: null });
    await revokeInvite(owner, revoked);
    await expect(getInvitePreview(revoked)).rejects.toThrow("invalid");
  });

  it("joins only with exact current acknowledgement; existing members must accept updates before sending", async () => {
    const preview = await getInvitePreview(code);
    await expect(acceptInvite(stranger, code)).rejects.toThrow("acknowledge");
    await expect(acceptInvite(stranger, code, preview.rulesVersion - 1)).rejects.toThrow("acknowledge");
    await acceptInvite(stranger, code, preview.rulesVersion);
    await expect(sendMessage(alice, channelId, "before acceptance")).rejects.toThrow("acknowledge");
    await acknowledgeCommunityRules(alice, communityId, preview.rulesVersion);
    await sendMessage(alice, channelId, "accepted");
    await updateCommunityRules(owner, communityId, { text: "Updated rules", required: true });
    await expect(acknowledgeCommunityRules(alice, communityId, preview.rulesVersion)).rejects.toThrow("changed");
    await expect(sendMessage(alice, channelId, "stale")).rejects.toThrow("acknowledge");
    await updateCommunityRules(owner, communityId, { text: "Updated rules", required: false });
    await sendMessage(alice, channelId, "optional now");
    expect((await listAuditLog(owner, communityId)).some((e) => e.action === "community.rules")).toBe(true);
  });
});

describe("private ban appeals", () => {
  let appealId: string;
  it("exposes only the caller's reason and rejects non-bans/outsiders/oversized appeals", async () => {
    await banMember(owner, communityId, alice, "Only Alice sees this reason <b>as text</b>");
    await expect(getCommunityView(alice, communityId)).rejects.toThrow("not found");
    expect((await listOwnRestrictions(alice))[0].reason).toContain("Only Alice");
    expect(await listOwnRestrictions(bob)).toEqual([]);
    await expect(submitBanAppeal(bob, communityId, "not banned")).rejects.toThrow("not found");
    await expect(submitBanAppeal(alice, communityId, "a".repeat(2001))).rejects.toThrow();
    await expect(listBanAppeals(bob, communityId)).rejects.toThrow("permission");
    await expect(listBanAppeals(alice, communityId)).rejects.toThrow("not found");
    await expect(listBanAppeals("missing-user", communityId)).rejects.toThrow();
  });
  it("serializes duplicate submissions and scopes appeal review IDs to the community", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => submitBanAppeal(alice, communityId, "Please review <img src=x>")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const appeals = await listBanAppeals(owner, communityId);
    expect(appeals).toHaveLength(1);
    appealId = appeals[0].id;
    expect((await listOwnRestrictions(alice))[0].content).toContain("<img");
    expect(await listOwnAppealHistory(bob)).toEqual([]);
    const other = await createCommunity(bob, "Other community");
    await expect(resolveBanAppeal(bob, other.communityId, appealId, "unban", "")).rejects.toThrow("not found");
    await expect(resolveBanAppeal(bob, communityId, appealId, "unban", "")).rejects.toThrow("permission");
  });
  it("prevents lower-ranked ban-capable moderators from overturning or upholding owner bans", async () => {
    const modRole = await createRole(owner, communityId, "Ban reviewer", ["BanMembers"]);
    await setMemberRole(owner, modRole, bob, true);
    for (const decision of ["uphold", "unban"]) await expect(resolveBanAppeal(bob, communityId, appealId, decision, "")).rejects.toThrow("ranked above");
    await expect(resolveBanAppeal(owner, communityId, appealId, "unexpected", "")).rejects.toThrow();
    await expect(resolveBanAppeal(owner, communityId, appealId, "uphold", "a".repeat(513))).rejects.toThrow();
    await expect(unbanMember(bob, communityId, alice)).rejects.toThrow("ranked above");
    expect((await listBanAppeals(bob, communityId))[0].resolution).toBeNull();
  });
  it("resolves once under concurrent review, preserves history after unban, and isolates a reissued ban", async () => {
    const results = await Promise.allSettled([resolveBanAppeal(owner, communityId, appealId, "unban", "Welcome back"), resolveBanAppeal(owner, communityId, appealId, "unban", "Welcome back")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [a] = await listOwnAppealHistory(alice);
    expect(a.resolution).toBe("unban");
    expect(await listOwnRestrictions(alice)).toEqual([]);
    await acceptInvite(alice, code);
    await banMember(owner, communityId, alice, "Second issuance");
    expect((await listOwnRestrictions(alice))[0].appealId).toBeNull();
    await submitBanAppeal(alice, communityId, "Second appeal");
    const second = (await listOwnRestrictions(alice))[0].appealId!;
    await resolveBanAppeal(owner, communityId, second, "uphold", "The ban remains.");
    expect((await listOwnRestrictions(alice))[0].resolution).toBe("uphold");
    await expect(submitBanAppeal(alice, communityId, "Duplicate after resolution")).rejects.toThrow("already submitted");
    await unbanMember(owner, communityId, alice);
    await acceptInvite(alice, code);
    await banMember(owner, communityId, alice, "Third issuance");
    await submitBanAppeal(alice, communityId, "Third appeal");
    await unbanMember(owner, communityId, alice);
    const rows = await db.select().from(banAppeal).where(and(eq(banAppeal.communityId, communityId), eq(banAppeal.userId, alice)));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.resolvedAt)).toBe(true);
    expect(rows.filter((r) => r.resolution === "unban")).toHaveLength(2);
    expect(await db.$count(member, and(eq(member.communityId, communityId), eq(member.userId, alice)))).toBe(0);
    const audit = await listAuditLog(owner, communityId);
    expect(audit.some((e) => e.action === "ban.appeal.unban")).toBe(true);
    expect(audit.filter((e) => e.action.startsWith("ban.appeal")).every((e) => !e.reason)).toBe(true);
  });
});
