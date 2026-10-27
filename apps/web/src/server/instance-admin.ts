import { consumeVoiceRooms } from "./voice-sfu";
import { lockVoiceLifecycle } from "./voice-locks";
import { captureVoiceCapabilities, invalidateLostVoiceCapabilities, invalidateVoiceMembership } from "./voice-control";
import { and, count, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "@/db";
import { abuseReport, channel, community, dmReport, instanceAdmin, instanceAuditLog, instanceSettings, member, message, session, user, userBadge, userSuspension } from "@/db/schema";
import type { Db } from "./access";
import { AppError, forbidden, notFound } from "./errors";
import { sendMail } from "@/lib/mail";
import { assertActiveUser, getInstanceSettings, isInstanceAdmin } from "./instance-policy";
import { requiredReason } from "./reports";
import { publish } from "./realtime";
import { afterAccessChange } from "./voice";
import { parse, uuid } from "./validation";

export interface AdminActor { userId: string; sessionId: string }
export async function requireInstanceAdmin(actor: AdminActor, tx: Db = db) {
  await assertActiveUser(actor.userId, tx);
  const [row] = await tx.select({ userId: instanceAdmin.userId })
    .from(instanceAdmin)
    .innerJoin(session, and(eq(session.userId, instanceAdmin.userId), eq(session.id, actor.sessionId), gt(session.expiresAt, new Date())))
    .where(eq(instanceAdmin.userId, actor.userId));
  if (!row) throw forbidden("Instance administrator access required.");
  return row;
}

function audit(tx: Db, actor: AdminActor, action: string, targetId: string, reason: string) {
  return tx.insert(instanceAuditLog).values({ actorId: actor.userId, action, targetId, reason });
}

/** Serializes admin membership/suspension changes, including concurrent last-admin attempts. */
async function mutate<T>(actor: AdminActor, fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) {
  return db.transaction(async (tx) => {
    await lockVoiceLifecycle(tx, "auth");
    await tx.execute(sql`select pg_advisory_xact_lock(187412, 1)`);
    await requireInstanceAdmin(actor, tx);
    return fn(tx);
  });
}

async function mutateVoice<T>(actor: AdminActor, fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) {
  const value = await mutate(actor, fn);
  await consumeVoiceRooms();
  return value;
}

export const USER_FILTERS = ["all", "pending", "active", "rejected", "suspended", "admins"] as const;
export type UserFilter = (typeof USER_FILTERS)[number];
const userFilterWhere: Record<UserFilter, SQL | undefined> = {
  all: undefined,
  pending: and(eq(user.approvalStatus, "pending"), isNull(userSuspension.userId)),
  active: and(eq(user.approvalStatus, "approved"), isNull(userSuspension.userId)),
  rejected: eq(user.approvalStatus, "rejected"),
  suspended: isNotNull(userSuspension.userId),
  admins: isNotNull(instanceAdmin.userId),
};

export const AUDIT_AREAS = ["all", "user", "community", "report", "instance"] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];
/** Admin rights and encryption identity resets are account changes, so they show up under "user". */
const auditAreaWhere: Record<AuditArea, SQL | undefined> = {
  all: undefined,
  user: or(ilike(instanceAuditLog.action, "user.%"), ilike(instanceAuditLog.action, "admin.%"), ilike(instanceAuditLog.action, "dm.identity.%")),
  community: ilike(instanceAuditLog.action, "community.%"),
  report: or(ilike(instanceAuditLog.action, "report.%"), ilike(instanceAuditLog.action, "dm.report.%")),
  instance: ilike(instanceAuditLog.action, "instance.%"),
};
export const PAGE_SIZE = 50;
const AUDIT_PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One extra row tells whether there is a next page, without a count query. */
const pageOf = <T>(rows: T[], size: number) => ({ items: rows.slice(0, size), hasMore: rows.length > size });

export interface DashboardQuery { search?: unknown; status?: unknown; filter?: unknown; area?: unknown; page?: unknown }
export async function adminDashboard(actor: AdminActor, query: DashboardQuery = {}) {
  await requireInstanceAdmin(actor);
  const search = parse(z.string().trim().max(100), query.search ?? "");
  const status = parse(z.enum(["open", "dismissed", "removed", "private"]), query.status ?? "open");
  const filter = parse(z.enum(USER_FILTERS), query.filter ?? "all");
  const area = parse(z.enum(AUDIT_AREAS), query.area ?? "all");
  const page = parse(z.number().int().min(1).max(1000), query.page ?? 1);
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const reporter = alias(user, "reporter");
  const [users, pending, communities, reports, logs, admins, settings, [stats]] = await Promise.all([
    db.select({ id: user.id, name: user.name, email: user.email, twoFactorEnabled: user.twoFactorEnabled, createdAt: user.createdAt,
      approvalStatus: user.approvalStatus, suspendedAt: userSuspension.createdAt, suspensionReason: userSuspension.reason, adminId: instanceAdmin.userId,
      hypesquad: sql<boolean>`exists (select 1 from ${userBadge} where ${userBadge.userId} = ${user.id} and ${userBadge.badge} = 'hypesquad')`,
      lastActiveAt: sql<Date | null>`(select max(${session.updatedAt}) from ${session} where ${session.userId} = ${user.id})`.mapWith(session.updatedAt),
      ownedCommunities: sql<number>`(select count(*) from ${community} where ${community.ownerId} = ${user.id})`.mapWith(Number) })
      .from(user).leftJoin(userSuspension, eq(userSuspension.userId, user.id)).leftJoin(instanceAdmin, eq(instanceAdmin.userId, user.id))
      .where(and(search ? or(ilike(user.name, pattern), ilike(user.email, pattern)) : undefined, userFilterWhere[filter]))
      .orderBy(desc(user.createdAt), user.id).limit(PAGE_SIZE + 1).offset((page - 1) * PAGE_SIZE),
    // The approval queue is oldest first: fair, and nobody waits forever at the bottom.
    db.select({ id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, createdAt: user.createdAt })
      .from(user).leftJoin(userSuspension, eq(userSuspension.userId, user.id))
      .where(and(eq(user.approvalStatus, "pending"), isNull(userSuspension.userId))).orderBy(user.createdAt, user.id).limit(100),
    db.select({ id: community.id, name: community.name, ownerId: community.ownerId, ownerEmail: user.email, createdAt: community.createdAt,
      discoverable: community.discoverable, suspendedAt: community.suspendedAt, suspensionReason: community.suspensionReason, verifiedAt: community.verifiedAt,
      members: sql<number>`(select count(*) from ${member} where ${member.communityId} = ${community.id})`.mapWith(Number) })
      .from(community).innerJoin(user, eq(user.id, community.ownerId))
      .where(search ? ilike(community.name, pattern) : undefined).orderBy(desc(community.createdAt), community.id)
      .limit(PAGE_SIZE + 1).offset((page - 1) * PAGE_SIZE),
    status === "private" ? [] : db.select({ id: abuseReport.id, communityId: abuseReport.communityId, communityName: community.name,
      messageId: abuseReport.messageId, reason: abuseReport.reason, status: abuseReport.status, resolution: abuseReport.resolution,
      reporterName: reporter.name, createdAt: abuseReport.createdAt }).from(abuseReport).leftJoin(community, eq(community.id, abuseReport.communityId))
      .leftJoin(reporter, eq(reporter.id, abuseReport.reporterId))
      .where(eq(abuseReport.status, status)).orderBy(desc(abuseReport.createdAt), abuseReport.id).limit(50),
    db.select({ id: instanceAuditLog.id, actorId: instanceAuditLog.actorId, actorName: user.name, action: instanceAuditLog.action,
      targetId: instanceAuditLog.targetId, reason: instanceAuditLog.reason, createdAt: instanceAuditLog.createdAt })
      .from(instanceAuditLog).leftJoin(user, eq(user.id, instanceAuditLog.actorId)).where(auditAreaWhere[area])
      .orderBy(desc(instanceAuditLog.id)).limit(AUDIT_PAGE_SIZE + 1).offset((page - 1) * AUDIT_PAGE_SIZE),
    db.select({ id: user.id, name: user.name, email: user.email }).from(instanceAdmin).innerJoin(user, eq(user.id, instanceAdmin.userId)),
    getInstanceSettings(),
    db.select({
      users: count(),
      pending: sql<number>`count(*) filter (where ${user.approvalStatus} = 'pending' and ${userSuspension.userId} is null)`.mapWith(Number),
      suspended: count(userSuspension.userId),
      openReports: sql<number>`(select count(*) from ${abuseReport} where ${abuseReport.status} = 'open')`.mapWith(Number),
      openPrivateReports: sql<number>`(select count(*) from ${dmReport} where ${dmReport.resolvedAt} is null)`.mapWith(Number),
      communities: sql<number>`(select count(*) from ${community})`.mapWith(Number),
    }).from(user).leftJoin(userSuspension, eq(userSuspension.userId, user.id)),
  ]);
  const auditPage = pageOf(logs, AUDIT_PAGE_SIZE);
  return {
    users: pageOf(users, PAGE_SIZE), pending, communities: pageOf(communities, PAGE_SIZE), reports, admins, settings, stats, filter,
    logs: { ...auditPage, items: await withTargetNames(auditPage.items) },
  };
}

/** Audit targets are bare ids; show the account or community name next to them while it still exists. */
async function withTargetNames<T extends { targetId: string }>(entries: T[]) {
  const ids = [...new Set(entries.map((e) => e.targetId))];
  const uuids = ids.filter((id) => UUID_PATTERN.test(id));
  const [users, communities] = await Promise.all([
    ids.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)) : [],
    uuids.length ? db.select({ id: community.id, name: community.name }).from(community).where(inArray(community.id, uuids)) : [],
  ]);
  const names = new Map([...users, ...communities].map((row) => [row.id, row.name]));
  return entries.map((e) => ({ ...e, targetName: names.get(e.targetId) ?? null }));
}
export type AdminDashboard = Awaited<ReturnType<typeof adminDashboard>>;

export async function setUserSuspension(actor: AdminActor, rawId: unknown, suspended: unknown, rawReason: unknown) {
  const targetId = parse(z.string().min(1).max(128), rawId);
  const enabled = parse(z.boolean(), suspended);
  const reason = parse(requiredReason, rawReason);
  await mutateVoice(actor, async (tx) => {
    const [target] = await tx.select({ id: user.id }).from(user).where(eq(user.id, targetId)).for("update");
    if (!target) throw notFound("Account not found.");
    // Administrators must first be demoted; this protects the last admin and prevents self-lockout.
    if (enabled && await isInstanceAdmin(targetId, tx)) throw forbidden("Remove this account's instance administrator rights before suspending it.");
    if (enabled) {
      await invalidateVoiceMembership(tx, { userId: targetId }, "account-suspended");
      await tx.insert(userSuspension).values({ userId: targetId, reason }).onConflictDoUpdate({
        target: userSuspension.userId, set: { reason, createdAt: new Date() },
      });
      await tx.delete(session).where(eq(session.userId, targetId));
    } else await tx.delete(userSuspension).where(eq(userSuspension.userId, targetId));
    await audit(tx, actor, enabled ? "user.suspend" : "user.unsuspend", targetId, reason);
  });
  if (enabled) await disconnectUser(targetId);
}
async function disconnectUser(userId: string) {
  const memberships = await db.select({ communityId: member.communityId }).from(member).where(eq(member.userId, userId));
  await Promise.all(memberships.map((m) => publish({ type: "member.removed", communityId: m.communityId, userId })));
  for (const m of memberships) await afterAccessChange(m.communityId);
}
export async function revokeUserSessions(actor: AdminActor, rawId: unknown, rawReason: unknown) {
  const targetId = parse(z.string().min(1).max(128), rawId);
  const reason = parse(requiredReason, rawReason);
  await mutateVoice(actor, async (tx) => {
    const [target] = await tx.select({ id: user.id }).from(user).where(eq(user.id, targetId));
    if (!target) throw notFound("Account not found.");
    await invalidateVoiceMembership(tx, { userId: targetId }, "sessions-revoked");
    await tx.delete(session).where(eq(session.userId, targetId));
    await audit(tx, actor, "user.sessions.revoke", targetId, reason);
  });
  await disconnectUser(targetId);
}
export async function setCommunitySuspension(actor: AdminActor, rawId: unknown, suspended: unknown, rawReason: unknown) {
  const id = parse(uuid, rawId);
  const enabled = parse(z.boolean(), suspended);
  const reason = parse(requiredReason, rawReason);
  await mutateVoice(actor, async (tx) => {
    if (enabled) await invalidateVoiceMembership(tx, { communityId: id }, "community-suspended");
    const rows = await tx.update(community).set({ suspendedAt: enabled ? new Date() : null, suspensionReason: enabled ? reason : null })
      .where(eq(community.id, id)).returning({ id: community.id });
    if (!rows.length) throw notFound("Community not found.");
    await audit(tx, actor, enabled ? "community.suspend" : "community.unsuspend", id, reason);
  });
  if (enabled) {
    await publish({ type: "community.deleted", communityId: id });
    await afterAccessChange(id);
  }
}
/** The verified badge: an instance administrator vouches that the community is who it claims to be. */
export async function setCommunityVerified(actor: AdminActor, rawId: unknown, verified: unknown, rawReason: unknown) {
  const id = parse(uuid, rawId);
  const enabled = parse(z.boolean(), verified);
  const reason = parse(requiredReason, rawReason);
  await mutate(actor, async (tx) => {
    const rows = await tx.update(community).set({ verifiedAt: enabled ? new Date() : null })
      .where(eq(community.id, id)).returning({ id: community.id });
    if (!rows.length) throw notFound("Community not found.");
    await audit(tx, actor, enabled ? "community.verify" : "community.unverify", id, reason);
  });
}

export async function transferCommunity(actor: AdminActor, rawId: unknown, rawEmail: unknown, rawReason: unknown) {
  const id = parse(uuid, rawId);
  const email = parse(z.email().max(254).transform((s) => s.toLowerCase()), rawEmail);
  const reason = parse(requiredReason, rawReason);
  await mutateVoice(actor, async (tx) => {
    const [c] = await tx.select({ id: community.id }).from(community).where(eq(community.id, id)).for("update");
    if (!c) throw notFound("Community not found.");
    const beforeVoice = await captureVoiceCapabilities(tx, { communityId: id });
    const [target] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email)).for("update");
    if (!target) throw notFound("Account not found.");
    await assertActiveUser(target.id, tx);
    const [membership] = await tx.select({ id: member.userId }).from(member).where(and(eq(member.communityId, id), eq(member.userId, target.id)));
    if (!membership) throw forbidden("The new owner must already be a member of this community.");
    const [{ owned }] = await tx.select({ owned: count() }).from(community).where(eq(community.ownerId, target.id));
    const settings = await getInstanceSettings(tx);
    if (owned >= settings.ownedCommunities) throw forbidden("The new owner has reached the community ownership limit.");
    await tx.update(community).set({ ownerId: target.id }).where(eq(community.id, id));
    await invalidateLostVoiceCapabilities(tx, beforeVoice);
    await audit(tx, actor, "community.transfer", id, `${reason} (new owner: ${target.id})`);
  });
  await publish({ type: "channels.changed", communityId: id });
  // The previous owner may lose rights they relied on in voice.
  await afterAccessChange(id);
}
export async function setInstanceAdmin(actor: AdminActor, rawId: unknown, enabled: unknown, rawReason: unknown) {
  const id = parse(z.string().min(1).max(128), rawId);
  const grant = parse(z.boolean(), enabled);
  const reason = parse(requiredReason, rawReason);
  await mutateVoice(actor, async (tx) => {
    const beforeVoice = await captureVoiceCapabilities(tx, { userId: id });
    const [target] = await tx.select({ id: user.id }).from(user).where(eq(user.id, id)).for("update");
    if (!target) throw notFound("Account not found.");
    if (grant) {
      await assertActiveUser(id, tx);
      await tx.insert(instanceAdmin).values({ userId: id }).onConflictDoNothing();
      // Keeps access if the rights are removed again while Closed Alpha is on.
      await tx.update(user).set({ approvalStatus: "approved" }).where(eq(user.id, id));
    } else {
      const [{ total }] = await tx.select({ total: count() }).from(instanceAdmin);
      if (total <= 1 && await isInstanceAdmin(id, tx)) throw forbidden("The last instance administrator cannot be removed.");
      await tx.delete(instanceAdmin).where(eq(instanceAdmin.userId, id));
    }
    await invalidateLostVoiceCapabilities(tx, beforeVoice);
    await audit(tx, actor, grant ? "admin.grant" : "admin.revoke", id, reason);
  });
}
/** Granted profile badges (today only HypeSquad); derived badges can't be granted. */
export async function setUserBadge(actor: AdminActor, rawId: unknown, rawBadge: unknown, enabled: unknown, rawReason: unknown) {
  const id = parse(z.string().min(1).max(128), rawId);
  const badge = parse(z.enum(["hypesquad"]), rawBadge);
  const grant = parse(z.boolean(), enabled);
  const reason = parse(requiredReason, rawReason);
  await mutate(actor, async (tx) => {
    const [target] = await tx.select({ id: user.id }).from(user).where(eq(user.id, id));
    if (!target) throw notFound("Account not found.");
    if (grant) await tx.insert(userBadge).values({ userId: id, badge }).onConflictDoNothing();
    else await tx.delete(userBadge).where(and(eq(userBadge.userId, id), eq(userBadge.badge, badge)));
    await audit(tx, actor, grant ? "user.badge.grant" : "user.badge.revoke", id, `${reason} (${badge})`);
  });
}
export const settingsInput = z.object({
  registrationOpen: z.boolean(), inviteMode: z.enum(["members", "admins", "disabled"]),
  ownedCommunities: z.number().int().min(1).max(1000), channelsPerCommunity: z.number().int().min(1).max(1000),
  rolesPerCommunity: z.number().int().min(1).max(1000), activeInvitesPerCommunity: z.number().int().min(1).max(1000),
});
export async function updateInstanceSettings(actor: AdminActor, input: unknown, rawReason: unknown) {
  const settings = parse(settingsInput, input);
  const reason = parse(requiredReason, rawReason);
  await mutate(actor, async (tx) => {
    await tx.insert(instanceSettings).values(settings).onConflictDoUpdate({ target: instanceSettings.id, set: settings });
    await audit(tx, actor, "instance.settings.update", "instance", `${reason} ${JSON.stringify(settings)}`);
  });
}

/** Closed Alpha decision for one account. Approval reopens rejected accounts; rejection only applies to pending ones. */
export async function setApproval(actor: AdminActor, rawId: unknown, rawDecision: unknown, rawReason: unknown) {
  const targetId = parse(z.string().min(1).max(128), rawId);
  const decision = parse(z.enum(["approved", "rejected"]), rawDecision);
  const reason = parse(requiredReason, rawReason);
  const target = await mutateVoice(actor, async (tx) => {
    const [row] = await tx.select({ id: user.id, email: user.email, status: user.approvalStatus }).from(user).where(eq(user.id, targetId)).for("update");
    if (!row) throw notFound("Account not found.");
    if (row.status === decision) throw new AppError("conflict", `This account is already ${decision}.`);
    if (decision === "rejected" && row.status !== "pending") throw new AppError("conflict", "Only pending accounts can be rejected. Suspend active accounts instead.");
    if (decision === "rejected") await invalidateVoiceMembership(tx, { userId: targetId }, "account-rejected");
    await tx.update(user).set({ approvalStatus: decision }).where(eq(user.id, targetId));
    if (decision === "rejected") await tx.delete(session).where(eq(session.userId, targetId));
    await audit(tx, actor, decision === "approved" ? "user.approve" : "user.reject", targetId, reason);
    return row;
  });
  if (decision === "approved") {
    const url = new URL("/sign-in", process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
    // The decision is committed; a mail outage must not turn it into an error.
    await sendMail(target.email, "Your openDiscord account is approved", `You're in. Sign in to start using openDiscord:\n${url}`)
      .catch((error: unknown) => console.error("[admin] approval email failed", error));
  }
}
export async function setClosedAlpha(actor: AdminActor, rawEnabled: unknown, rawReason: unknown) {
  const closedAlpha = parse(z.boolean(), rawEnabled);
  const reason = parse(requiredReason, rawReason);
  await mutateVoice(actor, async (tx) => {
    const beforeVoice = await captureVoiceCapabilities(tx);
    await tx.insert(instanceSettings).values({ closedAlpha }).onConflictDoUpdate({ target: instanceSettings.id, set: { closedAlpha } });
    await invalidateLostVoiceCapabilities(tx, beforeVoice);
    await audit(tx, actor, closedAlpha ? "instance.closed_alpha.enable" : "instance.closed_alpha.disable", "instance", reason);
  });
}

export async function reviewReport(actor: AdminActor, rawId: unknown, rawReason: unknown) {
  const id = parse(uuid, rawId);
  const reason = parse(requiredReason, rawReason);
  return mutate(actor, async (tx) => {
    const [report] = await tx.select().from(abuseReport).where(eq(abuseReport.id, id));
    if (!report) throw notFound("Report not found.");
    // Explicit and audited access to exactly the reported message; never a bypass for an entire community.
    await audit(tx, actor, "report.content.view", id, reason);
    if (!report.messageId) return { content: null, authorName: null, deleted: false };
    const [row] = await tx.select({ content: message.content, authorName: user.name }).from(message)
      .innerJoin(channel, eq(channel.id, message.channelId)).innerJoin(user, eq(user.id, message.authorId))
      .where(and(eq(message.id, report.messageId), eq(channel.communityId, report.communityId)));
    return { content: row?.content ?? null, authorName: row?.authorName ?? null, deleted: !row };
  });
}
export async function resolveReport(actor: AdminActor, rawId: unknown, rawOutcome: unknown, rawReason: unknown) {
  const id = parse(uuid, rawId);
  const outcome = parse(z.enum(["dismissed", "removed"]), rawOutcome);
  const reason = parse(requiredReason, rawReason);
  const event = await mutateVoice(actor, async (tx) => {
    const [report] = await tx.select().from(abuseReport).where(eq(abuseReport.id, id)).for("update");
    if (!report) throw notFound("Report not found.");
    if (report.status !== "open") throw new AppError("conflict", "This report has already been resolved.");
    let deleted: { channelId: string; id: string } | undefined;
    if (outcome === "removed") {
      if (report.messageId) {
        [deleted] = await tx.delete(message).where(and(eq(message.id, report.messageId),
          sql`${message.channelId} in (select ${channel.id} from ${channel} where ${channel.communityId} = ${report.communityId})`))
          .returning({ channelId: message.channelId, id: message.id });
      } else {
        await invalidateVoiceMembership(tx, { communityId: report.communityId }, "community-suspended");
        await tx.update(community).set({ suspendedAt: new Date(), suspensionReason: reason }).where(eq(community.id, report.communityId));
      }
    }
    await tx.update(abuseReport).set({ status: outcome, resolution: reason, resolvedBy: actor.userId, resolvedAt: new Date() }).where(eq(abuseReport.id, id));
    await audit(tx, actor, `report.${outcome}`, id, reason);
    return { deleted, communityId: report.communityId, suspend: outcome === "removed" && !report.messageId };
  });
  if (event.deleted) await publish({ type: "message.deleted", communityId: event.communityId, channelId: event.deleted.channelId, messageId: event.deleted.id });
  if (event.suspend) await publish({ type: "community.deleted", communityId: event.communityId });
}
