import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { abuseReport, adminVerification, instanceAdmin, instanceAuditLog, instanceSettings, message, session, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { createCommunity, createChannel, createInvite, acceptInvite, getInvitePreview } from "@/server/communities";
import { exportUserData } from "@/server/account";
import { requireMember } from "@/server/access";
import * as admin from "@/server/instance-admin";
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
async function makeSession(userId: string, elevated = false): Promise<admin.AdminActor> {
  const id = randomUUID();
  await db.insert(session).values({ id, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  if (elevated) await db.insert(adminVerification).values({ sessionId: id });
  return { userId, sessionId: id };
}

describe("instance administration", () => {
  beforeAll(async () => {
    const rootId = await fixtures.create("Instance operator");
    owner = await fixtures.create("Community owner");
    chatter = await fixtures.create("Chatter");
    outsider = await fixtures.create("Outsider");
    ids.push(rootId, owner, chatter, outsider);
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, rootId));
    await db.insert(instanceAdmin).values({ userId: rootId });
    root = await makeSession(rootId, true);
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

  it("separates instance rights from community ownership and requires a live elevated session", async () => {
    expect(await isInstanceAdmin(owner)).toBe(false);
    const ordinary = await makeSession(owner, true);
    await expect(admin.adminDashboard(ordinary)).rejects.toThrow(/administrator access/);
    const notElevated = await makeSession(root.userId);
    await expect(admin.adminDashboard(notElevated)).rejects.toThrow(/authenticator code/);
    await expect(admin.adminDashboard({ userId: root.userId, sessionId: ordinary.sessionId })).rejects.toThrow(/administrator access/);
    await expect(listMessages(root.userId, c.channelId)).rejects.toThrow(/not found/);
    await db.update(adminVerification).set({ verifiedAt: new Date(Date.now() - admin.ADMIN_VERIFICATION_MS - 1000) }).where(eq(adminVerification.sessionId, root.sessionId));
    await expect(admin.adminDashboard(root)).rejects.toThrow(/authenticator code/);
    await db.update(adminVerification).set({ verifiedAt: new Date() }).where(eq(adminVerification.sessionId, root.sessionId));
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
    const s1 = await makeSession(chatter, true);
    await makeSession(chatter);
    await admin.setUserSuspension(root, chatter, true, "Repeated abuse");
    expect(await db.select().from(session).where(eq(session.userId, chatter))).toHaveLength(0);
    expect(await db.select().from(adminVerification).where(eq(adminVerification.sessionId, s1.sessionId))).toHaveLength(0);
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
      await expect(auth.api.signUpEmail({ body: { email: `${randomUUID()}@example.test`, name: "Blocked signup", password: "correct horse battery" } })).rejects.toThrow(/Registration is closed/);
      await expect(createInvite(chatter, c.communityId, { maxUses: null, expiresInHours: null })).rejects.toThrow(/disabled/);
      await expect(acceptInvite(outsider, inviteCode)).rejects.toThrow(/disabled/);
      await expect(createCommunity(chatter, "Over limit")).rejects.toThrow(/at most 1/);
      await expect(createChannel(chatter, c.communityId, "over-limit")).rejects.toThrow(/at most 1/);
      await admin.updateInstanceSettings(root, { ...settings, inviteMode: "admins" }, "Restrict invite creation");
      await expect(createInvite(chatter, c.communityId, { maxUses: null, expiresInHours: null })).rejects.toThrow(/Only instance administrators/);
    } finally { await db.delete(instanceSettings); }
  });
  it("requires 2FA before granting rights and protects admin accounts", async () => {
    await expect(admin.setInstanceAdmin(root, owner, true, "Grant rights")).rejects.toThrow(/enable two-factor/);
    await expect(admin.setUserSuspension(root, root.userId, true, "Self suspension")).rejects.toThrow(/Remove this account/);
    // RESTRICT guards erasure even if an account-deletion path misses the application hook.
    await expect(db.delete(user).where(eq(user.id, root.userId))).rejects.toThrow();
  });
  it("serializes concurrent demotions and preserves the last administrator", async () => {
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, owner));
    await admin.setInstanceAdmin(root, owner, true, "Second administrator");
    const second = await makeSession(owner, true);
    const outcomes = await Promise.allSettled([
      admin.setInstanceAdmin(root, owner, false, "Concurrent demotion one"),
      admin.setInstanceAdmin(second, root.userId, false, "Concurrent demotion two"),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const admins = await db.select().from(instanceAdmin);
    expect(admins).toHaveLength(1);
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
  it("verifies a real TOTP code and binds the privilege to the current session", async () => {
    const signup = await auth.api.signUpEmail({ body: { email, password, name: "2FA Admin" }, returnHeaders: true });
    accountId = signup.response.user.id;
    headers = new Headers({ cookie: signup.headers.get("set-cookie")!.split(";")[0] });
    const enabled = await auth.api.enableTwoFactor({ headers, body: { password } });
    if (!("totpURI" in enabled)) throw new Error("Expected TOTP setup");
    secret = new URL(enabled.totpURI).searchParams.get("secret")!;
    const code = authenticatorCode(secret);
    const confirmed = await auth.api.verifyTOTP({ headers, body: { code }, returnHeaders: true });
    headers = new Headers({ cookie: confirmed.headers.get("set-cookie")!.split(";")[0] });
    const current = (await auth.api.getSession({ headers }))!;
    actor = { userId: accountId, sessionId: current.session.id };
    await db.insert(instanceAdmin).values({ userId: accountId });
    await expect(admin.requireInstanceAdmin(actor)).rejects.toThrow(/authenticator code/);
    await expect(auth.api.getTOTPURI({ headers, body: { password } })).rejects.toThrow(/authenticator code/);
    await expect(auth.api.generateBackupCodes({ headers, body: { password } })).rejects.toThrow(/authenticator code/);
    await admin.verifyAdminSession(actor, () => auth.api.verifyTOTP({ headers, body: { code } }));
    await expect(admin.requireInstanceAdmin(actor)).resolves.toBeTruthy();
    await expect(auth.api.disableTwoFactor({ headers, body: { password } })).rejects.toThrow(/mandatory/);
    await expect(auth.api.deleteUser({ headers, body: { password } })).rejects.toThrow(/administrator rights/);
  });
  it("persists invalid step-up attempts and limits them across sessions", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(admin.verifyAdminSession(actor, () => auth.api.verifyTOTP({ headers, body: { code: "invalid" } }))).rejects.toThrow(/Invalid authenticator/);
    }
    const code = authenticatorCode(secret);
    await expect(admin.verifyAdminSession(actor, () => auth.api.verifyTOTP({ headers, body: { code } }))).rejects.toThrow(/Too many invalid codes/);
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
