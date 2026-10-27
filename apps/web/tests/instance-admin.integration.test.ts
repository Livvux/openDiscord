import { REGISTRATION_HEADERS } from "./helpers";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { abuseReport, instanceAdmin, instanceAuditLog, instanceSettings, message, session, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { createCommunity, createChannel, createInvite, acceptInvite, getInvitePreview } from "@/server/communities";
import { exportUserData } from "@/server/account";
import { requireMember } from "@/server/access";
import * as admin from "@/server/instance-admin";
import { badgesOf } from "@/server/badges";
import { isInstanceAdmin } from "@/server/instance-policy";
import { listMessages, sendMessage } from "@/server/messages";
import { reportContent } from "@/server/reports";
import { testUsers } from "./helpers";
import { authenticatorCode } from "./totp";

const fixtures = testUsers();
let root: admin.AdminActor;
let owner: string;
let chatter: string;
let outsider: string;
let c: Awaited<ReturnType<typeof createCommunity>>;
let reportId: string;
let messageId: string;
let inviteCode: string;
const ids: string[] = [];
async function makeSession(userId: string): Promise<admin.AdminActor> {
  const id = randomUUID();
  await db.insert(session).values({ id, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  return { userId, sessionId: id };
}

describe("instance administration", () => {
  beforeAll(async () => {
    const rootId = await fixtures.create("Instance operator");
    owner = await fixtures.create("Community owner");
    chatter = await fixtures.create("Chatter");
    outsider = await fixtures.create("Outsider");
    ids.push(rootId, owner, chatter, outsider);
    await db.insert(instanceAdmin).values({ userId: rootId });
    root = await makeSession(rootId);
    c = await createCommunity(owner, "Private community");
    inviteCode = await createInvite(owner, c.communityId, { maxUses: null, expiresInHours: null });
    await acceptInvite(chatter, inviteCode);
    messageId = (await sendMessage(chatter, c.channelId, "Private reported body")).id;
  });
  afterAll(async () => {
    await db.delete(instanceSettings);
    await db.delete(abuseReport).where(inArray(abuseReport.reporterId, ids));
    await db.delete(instanceAuditLog).where(inArray(instanceAuditLog.actorId, ids));
    await db.delete(instanceAdmin).where(inArray(instanceAdmin.userId, ids));
    await fixtures.cleanup();
  });

  it("requires a live admin session without requiring two-factor authentication", async () => {
    expect(await isInstanceAdmin(owner)).toBe(false);
    const ordinary = await makeSession(owner);
    await expect(admin.adminDashboard(ordinary)).rejects.toThrow(/administrator access/);
    const fresh = await makeSession(root.userId);
    await expect(admin.adminDashboard(fresh)).resolves.toBeTruthy();
    await expect(admin.adminDashboard({ userId: root.userId, sessionId: ordinary.sessionId })).rejects.toThrow(/administrator access/);
    await expect(listMessages(root.userId, c.channelId)).rejects.toThrow(/not found/);
    await db.update(session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(session.id, fresh.sessionId));
    await expect(admin.adminDashboard(fresh)).rejects.toThrow(/administrator access/);
    await db.delete(session).where(eq(session.id, fresh.sessionId));
    await expect(admin.adminDashboard(fresh)).rejects.toThrow(/administrator access/);
  });
  it("accepts member reports, rejects outsiders and duplicates, and does not expose bodies in lists", async () => {
    await expect(reportContent(outsider, { messageId, reason: "Abuse" })).rejects.toThrow(/not found/);
    await reportContent(chatter, { messageId, reason: "Please review this abuse" });
    await reportContent(chatter, { communityId: c.communityId, reason: "Community abuse" });
    await expect(reportContent(chatter, { messageId, reason: "Duplicate" })).rejects.toThrow(/already reported/);
    await expect(reportContent(chatter, { messageId, communityId: c.communityId, reason: "Invalid" })).rejects.toThrow(/one report target/);
    const dashboard = await admin.adminDashboard(root);
    reportId = dashboard.reports.find((r) => r.messageId === messageId)!.id;
    expect(JSON.stringify(dashboard)).not.toContain("Private reported body");
    await expect(admin.reviewReport(root, reportId, " ")).rejects.toThrow(/reason/);
    expect((await admin.reviewReport(root, reportId, "Investigating reported abuse")).content).toBe("Private reported body");
    const logs = await db.select().from(instanceAuditLog).where(and(eq(instanceAuditLog.action, "report.content.view"), eq(instanceAuditLog.targetId, reportId)));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("Private reported body");
  });
  it("removes reported content and resolves each report once with an audit record", async () => {
    await admin.resolveReport(root, reportId, "removed", "Confirmed abusive content");
    expect(await db.select().from(message).where(eq(message.id, messageId))).toHaveLength(0);
    const [report] = await db.select().from(abuseReport).where(eq(abuseReport.id, reportId));
    expect(report.status).toBe("removed");
    expect(report.resolvedBy).toBe(root.userId);
    await expect(admin.resolveReport(root, reportId, "dismissed", "Again")).rejects.toThrow(/already been resolved/);
  });
  it("suspends communities for owners, members, invite previews and joins, and can restore them", async () => {
    await admin.setCommunitySuspension(root, c.communityId, true, "Abuse investigation");
    await expect(listMessages(owner, c.channelId)).rejects.toThrow(/not found/);
    await expect(sendMessage(chatter, c.channelId, "Forbidden message")).rejects.toThrow(/not found/);
    await expect(createChannel(owner, c.communityId, "another")).rejects.toThrow(/not found/);
    await expect(getInvitePreview(inviteCode)).rejects.toThrow(/invalid|expired/);
    await expect(acceptInvite(outsider, inviteCode)).rejects.toThrow(/not found/);
    await admin.setCommunitySuspension(root, c.communityId, false, "Investigation concluded");
    await expect(requireMember(db, c.communityId, owner)).resolves.toBeTruthy();
  });
  it("revokes every account session and blocks suspended users until explicitly restored", async () => {
    await makeSession(chatter);
    await makeSession(chatter);
    await admin.setUserSuspension(root, chatter, true, "Repeated abuse");
    expect(await db.select().from(session).where(eq(session.userId, chatter))).toHaveLength(0);
    await expect(sendMessage(chatter, c.channelId, "Blocked")).rejects.toThrow(/suspended/);
    await expect(createCommunity(chatter, "Blocked")).rejects.toThrow(/suspended/);
    await expect(acceptInvite(chatter, inviteCode)).rejects.toThrow(/suspended/);
    await admin.setUserSuspension(root, chatter, false, "Appeal accepted");
    await expect(requireMember(db, c.communityId, chatter)).resolves.toBeTruthy();
    await makeSession(chatter);
    await admin.revokeUserSessions(root, chatter, "Compromised device");
    expect(await db.select().from(session).where(eq(session.userId, chatter))).toHaveLength(0);
  });
  it("transfers ownership only to active existing members", async () => {
    const [target] = await db.select({ email: user.email }).from(user).where(eq(user.id, outsider));
    await expect(admin.transferCommunity(root, c.communityId, target.email, "Transfer request")).rejects.toThrow(/already be a member/);
    const [next] = await db.select({ email: user.email }).from(user).where(eq(user.id, chatter));
    await admin.transferCommunity(root, c.communityId, next.email, "Owner requested handover");
    expect((await requireMember(db, c.communityId, chatter)).authority.isOwner).toBe(true);
    expect((await requireMember(db, c.communityId, owner)).authority.isOwner).toBe(false);
  });
  it("enforces settings on registration, existing invites, creation and ownership limits", async () => {
    const settings = { registrationOpen: false, inviteMode: "disabled" as const, ownedCommunities: 1, channelsPerCommunity: 1, rolesPerCommunity: 1, activeInvitesPerCommunity: 1 };
    try {
      await admin.updateInstanceSettings(root, settings, "Temporarily tighten limits");
      await expect(auth.api.signUpEmail({ headers: REGISTRATION_HEADERS, body: { email: `${randomUUID()}@example.test`, name: "Blocked signup", password: "correct horse battery" } })).rejects.toThrow(/Registration is closed/);
      await expect(createInvite(chatter, c.communityId, { maxUses: null, expiresInHours: null })).rejects.toThrow(/disabled/);
      await expect(acceptInvite(outsider, inviteCode)).rejects.toThrow(/disabled/);
      await expect(createCommunity(chatter, "Over limit")).rejects.toThrow(/at most 1/);
      await expect(createChannel(chatter, c.communityId, "over-limit")).rejects.toThrow(/at most 1/);
      await admin.updateInstanceSettings(root, { ...settings, inviteMode: "admins" }, "Restrict invite creation");
      await expect(createInvite(chatter, c.communityId, { maxUses: null, expiresInHours: null })).rejects.toThrow(/Only instance administrators/);
    } finally { await db.delete(instanceSettings); }
  });
  it("grants rights without 2FA while preserving admin account protection", async () => {
    await admin.setInstanceAdmin(root, owner, true, "Grant rights without requiring 2FA");
    const granted = await makeSession(owner);
    await expect(admin.adminDashboard(granted)).resolves.toBeTruthy();
    await admin.setInstanceAdmin(root, owner, false, "Remove temporary administrator");
    await expect(admin.adminDashboard(granted)).rejects.toThrow(/administrator access/);
    await expect(admin.setUserSuspension(root, root.userId, true, "Self suspension")).rejects.toThrow(/Remove this account/);
    // RESTRICT guards erasure even if an account-deletion path misses the application hook.
    await expect(db.delete(user).where(eq(user.id, root.userId))).rejects.toThrow();
  });
  it("grants and removes the HypeSquad badge with an audit record", async () => {
    await expect(admin.setUserBadge(root, chatter, "staff", true, "Not a grantable badge")).rejects.toThrow();
    await expect(admin.setUserBadge(await makeSession(owner), chatter, "hypesquad", true, "Not an admin")).rejects.toThrow(/administrator access/);
    await admin.setUserBadge(root, chatter, "hypesquad", true, "Approved HypeSquad application");
    await admin.setUserBadge(root, chatter, "hypesquad", true, "Granting twice is harmless");
    expect(await badgesOf(chatter)).toContain("hypesquad");
    const listed = await admin.adminDashboard(root, { search: "Chatter", filter: "all" });
    expect(listed.users.items.find((u) => u.id === chatter)?.hypesquad).toBe(true);
    await admin.setUserBadge(root, chatter, "hypesquad", false, "Badge removed");
    expect(await badgesOf(chatter)).not.toContain("hypesquad");
    const audit = await admin.adminDashboard(root, { area: "user" });
    expect(audit.logs.items.every((e) => /^(user|admin|dm\.identity)\./.test(e.action))).toBe(true);
    const revoke = audit.logs.items.find((e) => e.action === "user.badge.revoke" && e.targetId === chatter);
    expect(revoke?.targetName).toBe("Chatter");
    expect(revoke?.reason).toBe("Badge removed (hypesquad)");
  });
  it("pages users, communities and the audit log without overlap", async () => {
    const first = await admin.adminDashboard(root);
    expect(first.users.items.length).toBeLessThanOrEqual(admin.PAGE_SIZE);
    expect(first.logs.items.find((e) => e.targetId === c.communityId)?.targetName).toBe("Private community");
    const second = await admin.adminDashboard(root, { page: 2 });
    const firstIds = new Set(first.users.items.map((u) => u.id));
    expect(second.users.items.some((u) => firstIds.has(u.id))).toBe(false);
    await expect(admin.adminDashboard(root, { page: 0 })).rejects.toThrow();
    await expect(admin.adminDashboard(root, { area: "everything" })).rejects.toThrow();
  });
  it("serializes concurrent demotions and preserves the last administrator", async () => {
    // The last-admin rule is instance-wide; a developer database may already have its own admins.
    const others = (await db.select().from(instanceAdmin)).filter((a) => !ids.includes(a.userId)).length;
    await admin.setInstanceAdmin(root, owner, true, "Second administrator");
    const second = await makeSession(owner);
    const outcomes = await Promise.allSettled([
      admin.setInstanceAdmin(root, owner, false, "Concurrent demotion one"),
      admin.setInstanceAdmin(second, root.userId, false, "Concurrent demotion two"),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const admins = (await db.select().from(instanceAdmin)).filter((a) => ids.includes(a.userId));
    expect(admins).toHaveLength(1);
    if (others) return;
    const remaining = admins[0].userId === root.userId ? root : second;
    await expect(admin.setInstanceAdmin(remaining, remaining.userId, false, "Remove last admin")).rejects.toThrow(/last instance administrator/);
  });
});

describe("admin authentication lifecycle", () => {
  const email = `admin-auth-${randomUUID()}@example.test`;
  const password = "correct horse battery";
  let accountId: string;
  let headers: Headers;
  let actor: admin.AdminActor;
  let secret: string;
  afterAll(async () => {
    if (!accountId) return;
    await db.delete(instanceAdmin).where(eq(instanceAdmin.userId, accountId));
    await db.delete(instanceAuditLog).where(eq(instanceAuditLog.actorId, accountId));
    await db.delete(user).where(eq(user.id, accountId));
  });
  it("allows administrators to enable and disable optional two-factor authentication", async () => {
    const signup = await auth.api.signUpEmail({ headers: REGISTRATION_HEADERS, body: { email, password, name: "Optional 2FA Admin" }, returnHeaders: true });
    accountId = signup.response.user.id;
    headers = new Headers({ cookie: signup.headers.get("set-cookie")!.split(";")[0] });
    await db.insert(instanceAdmin).values({ userId: accountId });
    let current = (await auth.api.getSession({ headers }))!;
    actor = { userId: accountId, sessionId: current.session.id };
    await expect(admin.requireInstanceAdmin(actor)).resolves.toBeTruthy();
    const enabled = await auth.api.enableTwoFactor({ headers, body: { password } });
    if (!("totpURI" in enabled)) throw new Error("Expected TOTP setup");
    secret = new URL(enabled.totpURI).searchParams.get("secret")!;
    const confirmed = await auth.api.verifyTOTP({ headers, body: { code: authenticatorCode(secret) }, returnHeaders: true });
    headers = new Headers({ cookie: confirmed.headers.get("set-cookie")!.split(";")[0] });
    current = (await auth.api.getSession({ headers }))!;
    actor = { userId: accountId, sessionId: current.session.id };
    await expect(admin.requireInstanceAdmin(actor)).resolves.toBeTruthy();
    const disabled = await auth.api.disableTwoFactor({ headers, body: { password }, returnHeaders: true });
    headers = new Headers({ cookie: disabled.headers.get("set-cookie")!.split(";")[0] });
    current = (await auth.api.getSession({ headers }))!;
    expect(current.user.twoFactorEnabled).toBe(false);
    actor = { userId: accountId, sessionId: current.session.id };
    await expect(admin.requireInstanceAdmin(actor)).resolves.toBeTruthy();
    await expect(auth.api.deleteUser({ headers, body: { password } })).rejects.toThrow(/administrator rights/);
  });
  it("blocks suspended accounts at sign-in and does not issue new sessions", async () => {
    await db.delete(instanceAdmin).where(eq(instanceAdmin.userId, accountId));
    const { userSuspension } = await import("@/db/schema");
    await db.insert(userSuspension).values({ userId: accountId, reason: "Authentication suspension test" });
    await db.delete(session).where(eq(session.userId, accountId));
    await expect(auth.api.signInEmail({ body: { email, password } })).rejects.toThrow(/suspended/);
    expect(await db.select().from(session).where(eq(session.userId, accountId))).toHaveLength(0);
    // Portability remains scoped to the account; no admin-only data is returned.
    expect((await exportUserData(accountId)).profile.id).toBe(accountId);
  });
});
