import { voiceTransaction } from "./voice-sfu";
import { lockVoiceLifecycle } from "./voice-locks";
import { captureVoiceCapabilities, invalidateLostVoiceCapabilities, invalidateVoiceMembership } from "./voice-control";
import { requireBanReviewAuthority } from "./community-trust";
import { getInstanceSettings } from "./instance-policy";
// Members, roles, bans and the audit log. Every mutation re-checks authority inside a
// transaction that locks the community row, so concurrent role changes can't race a kick.
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, max, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, ban, banAppeal, member, memberRole, role, user } from "@/db/schema";
import { loadAuthority, lockCommunity, requireMember, type Db } from "./access";
import { avatarOf } from "./avatars";
import { forbidden, invalid, notFound } from "./errors";
import { enforceCap } from "./limits";
import { canManageRole, has, outranks, Permission, permissionsFromNames, type MemberAuthority } from "./permissions";
import { publish } from "./realtime";
import { afterAccessChange } from "./voice";
import { parse, reason as reasonSchema, roleName, uuid } from "./validation";
import { z } from "zod";

export interface MemberSummary {
  userId: string;
  name: string;
  avatar: string | null;
  isOwner: boolean;
  roleIds: string[];
  joinedAt: Date;
}

export interface RoleSummary {
  id: string;
  name: string;
  permissions: number;
  position: number;
  isDefault: boolean;
}

/** Member list. Shows display names only, never email addresses. */
export async function listMembers(userId: string, rawCommunityId: unknown): Promise<MemberSummary[]> {
  const communityId = parse(uuid, rawCommunityId);
  const { community } = await requireMember(db, communityId, userId);
  const rows = await db
    .select({ userId: member.userId, name: user.name, avatar: avatarOf(user.id), joinedAt: member.joinedAt })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.communityId, communityId))
    .orderBy(asc(user.name));
  const assignments = await db
    .select({ userId: memberRole.userId, roleId: memberRole.roleId })
    .from(memberRole)
    .where(eq(memberRole.communityId, communityId));
  return rows.map((r) => ({
    ...r,
    isOwner: r.userId === community.ownerId,
    roleIds: assignments.filter((a) => a.userId === r.userId).map((a) => a.roleId),
  }));
}

/** Up to 8 members whose display name starts with `q` (mention autocomplete). Names only. */
export async function searchMembers(userId: string, rawCommunityId: unknown, rawQuery: unknown): Promise<{ id: string; name: string }[]> {
  const communityId = parse(uuid, rawCommunityId);
  const q = parse(z.string().trim().max(64), rawQuery ?? "");
  await requireMember(db, communityId, userId);
  const pattern = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .select({ id: user.id, name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.communityId, communityId), ilike(user.name, pattern)))
    .orderBy(asc(user.name))
    .limit(8);
}

export async function listRoles(userId: string, rawCommunityId: unknown): Promise<RoleSummary[]> {
  const communityId = parse(uuid, rawCommunityId);
  await requireMember(db, communityId, userId);
  return db
    .select({ id: role.id, name: role.name, permissions: role.permissions, position: role.position, isDefault: role.isDefault })
    .from(role)
    .where(eq(role.communityId, communityId))
    .orderBy(desc(role.position), asc(role.id));
}

async function requireTarget(tx: Db, communityId: string, actor: MemberAuthority, targetUserId: string) {
  const target = await loadAuthority(tx, communityId, targetUserId);
  if (!target) throw notFound("That person is not a member.");
  if (!outranks(actor, target)) throw forbidden("You can only moderate members ranked below you.");
  return target;
}

export async function kickMember(actorId: string, rawCommunityId: unknown, rawTargetId: unknown, rawReason?: unknown) {
  const communityId = parse(uuid, rawCommunityId);
  const targetId = parse(z.string().min(1), rawTargetId);
  const reason = parse(reasonSchema, rawReason || undefined);
  if (targetId === actorId) throw invalid("Use “Leave community” instead.");
  await voiceTransaction(async (tx) => {
    await lockVoiceLifecycle(tx);
    await lockCommunity(tx, communityId);
    const { authority } = await requireMember(tx, communityId, actorId, Permission.KickMembers);
    await requireTarget(tx, communityId, authority, targetId);
    await invalidateVoiceMembership(tx, { communityId, userId: targetId }, "member-removed");
    await tx.delete(member).where(and(eq(member.communityId, communityId), eq(member.userId, targetId)));
    await tx.insert(auditLog).values({ communityId, actorId, action: "member.kick", targetId, reason });
  });
  await publish({ type: "member.removed", communityId, userId: targetId });
  await afterAccessChange(communityId);
}

export async function banMember(actorId: string, rawCommunityId: unknown, rawTargetId: unknown, rawReason?: unknown) {
  const communityId = parse(uuid, rawCommunityId);
  const targetId = parse(z.string().min(1), rawTargetId);
  const reason = parse(reasonSchema, rawReason || undefined);
  if (targetId === actorId) throw invalid("You can't ban yourself.");
  await voiceTransaction(async (tx) => {
    await lockVoiceLifecycle(tx);
    await lockCommunity(tx, communityId);
    const { authority } = await requireMember(tx, communityId, actorId, Permission.BanMembers);
    await requireTarget(tx, communityId, authority, targetId);
    await tx.insert(ban).values({ communityId, userId: targetId, reason, moderatorId: actorId }).onConflictDoNothing();
    await invalidateVoiceMembership(tx, { communityId, userId: targetId }, "member-removed");
    await tx.delete(member).where(and(eq(member.communityId, communityId), eq(member.userId, targetId)));
    await tx.insert(auditLog).values({ communityId, actorId, action: "member.ban", targetId, reason });
  });
  await publish({ type: "member.removed", communityId, userId: targetId });
  await afterAccessChange(communityId);
}

export interface BanSummary {
  userId: string;
  name: string;
  reason: string | null;
  createdAt: Date;
}

export async function listBans(actorId: string, rawCommunityId: unknown): Promise<BanSummary[]> {
  const communityId = parse(uuid, rawCommunityId);
  await requireMember(db, communityId, actorId, Permission.BanMembers);
  return db
    .select({ userId: ban.userId, name: user.name, reason: ban.reason, createdAt: ban.createdAt })
    .from(ban)
    .innerJoin(user, eq(user.id, ban.userId))
    .where(eq(ban.communityId, communityId))
    .orderBy(desc(ban.createdAt));
}

export async function unbanMember(actorId: string, rawCommunityId: unknown, rawTargetId: unknown) {
  const communityId = parse(uuid, rawCommunityId);
  const targetId = parse(z.string().min(1), rawTargetId);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    const { authority } = await requireMember(tx, communityId, actorId, Permission.BanMembers);
    const [existing] = await tx.select().from(ban).where(and(eq(ban.communityId, communityId), eq(ban.userId, targetId)));
    if (!existing) throw notFound("That person is not banned.");
    // Lower-ranked moderators can't overturn a ban issued by someone above them.
    await requireBanReviewAuthority(tx, communityId, actorId, authority, existing.moderatorId);
    await tx.delete(ban).where(and(eq(ban.communityId, communityId), eq(ban.userId, targetId)));
    await tx.update(banAppeal).set({ resolvedAt: new Date(), resolvedBy: actorId, resolution: "unban" })
      .where(and(eq(banAppeal.communityId, communityId), eq(banAppeal.userId, targetId), eq(banAppeal.banId, existing.id), isNull(banAppeal.resolvedAt)));
    await tx.insert(auditLog).values({ communityId, actorId, action: "member.unban", targetId });
  });
}

// --- Roles ------------------------------------------------------------------

const permissionNames = z.array(z.string()).max(32);

export async function createRole(actorId: string, rawCommunityId: unknown, rawName: unknown, rawPermissions: unknown) {
  const communityId = parse(uuid, rawCommunityId);
  const name = parse(roleName, rawName);
  const permissions = permissionsFromNames(parse(permissionNames, rawPermissions));
  return db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    const { authority } = await requireMember(tx, communityId, actorId);
    const [{ total }] = await tx.select({ total: count() }).from(role).where(eq(role.communityId, communityId));
    const CAPS = await getInstanceSettings(tx);
    enforceCap(total, CAPS.rolesPerCommunity, `A community can have at most ${CAPS.rolesPerCommunity} roles.`);
    // Checked against a slot just below the creator, then made real by shifting their roles up.
    // Rank 0 means only the default role: there is no slot below it.
    if (authority.rank < 1 || !canManageRole(authority, authority.rank - 1, permissions)) throw forbidden();
    let position: number;
    if (authority.isOwner) {
      const [{ top }] = await tx.select({ top: max(role.position) }).from(role).where(eq(role.communityId, communityId));
      position = (top ?? 0) + 1;
    } else {
      position = authority.rank;
      await tx
        .update(role)
        .set({ position: sql`${role.position} + 1` })
        .where(and(eq(role.communityId, communityId), gte(role.position, position)));
    }
    const [created] = await tx.insert(role).values({ communityId, name, permissions, position }).returning({ id: role.id });
    await tx.insert(auditLog).values({ communityId, actorId, action: "role.create", targetId: created.id });
    return created.id;
  });
}

async function requireManageableRole(tx: Db, actorId: string, roleId: string) {
  // A role's community never changes, so it is safe to read before locking; everything else is re-read after.
  const [ref] = await tx.select({ communityId: role.communityId }).from(role).where(eq(role.id, roleId));
  if (!ref) throw notFound("Role not found.");
  await lockCommunity(tx, ref.communityId);
  const [r] = await tx.select().from(role).where(eq(role.id, roleId));
  if (!r) throw notFound("Role not found.");
  const { authority } = await requireMember(tx, r.communityId, actorId);
  if (!canManageRole(authority, r.position, r.isDefault ? 0 : r.permissions)) throw forbidden();
  // The default role sits at position 0, which only holders of ManageRoles can edit.
  if (r.isDefault && !has(authority, Permission.ManageRoles)) throw forbidden();
  return { role: r, authority };
}

export async function updateRole(actorId: string, rawRoleId: unknown, rawName: unknown, rawPermissions: unknown) {
  const roleId = parse(uuid, rawRoleId);
  const name = parse(roleName, rawName);
  const permissions = permissionsFromNames(parse(permissionNames, rawPermissions));
  await voiceTransaction(async (tx) => {
    await lockVoiceLifecycle(tx);
    const { role: r, authority } = await requireManageableRole(tx, actorId, roleId);
    if (!canManageRole(authority, r.position, permissions)) throw forbidden("You can't grant permissions you don't have.");
    const beforeVoice = await captureVoiceCapabilities(tx, { communityId: r.communityId });
    await tx.update(role).set({ name: r.isDefault ? r.name : name, permissions }).where(eq(role.id, roleId));
    await invalidateLostVoiceCapabilities(tx, beforeVoice);
    await tx.insert(auditLog).values({ communityId: r.communityId, actorId, action: "role.update", targetId: roleId });
    return r.communityId;
  }).then(afterAccessChange);
}

export async function deleteRole(actorId: string, rawRoleId: unknown) {
  const roleId = parse(uuid, rawRoleId);
  await voiceTransaction(async (tx) => {
    await lockVoiceLifecycle(tx);
    const { role: r } = await requireManageableRole(tx, actorId, roleId);
    if (r.isDefault) throw forbidden("The default role can't be deleted.");
    const beforeVoice = await captureVoiceCapabilities(tx, { communityId: r.communityId });
    await tx.delete(role).where(eq(role.id, roleId));
    await invalidateLostVoiceCapabilities(tx, beforeVoice);
    await tx.insert(auditLog).values({ communityId: r.communityId, actorId, action: "role.delete", targetId: r.name });
    return r.communityId;
  }).then(afterAccessChange);
}

export async function setMemberRole(actorId: string, rawRoleId: unknown, rawTargetId: unknown, assigned: boolean) {
  const roleId = parse(uuid, rawRoleId);
  const targetId = parse(z.string().min(1), rawTargetId);
  await voiceTransaction(async (tx) => {
    await lockVoiceLifecycle(tx);
    const { role: r, authority } = await requireManageableRole(tx, actorId, roleId);
    if (r.isDefault) throw invalid("Everyone has the default role.");
    if (targetId !== actorId) await requireTarget(tx, r.communityId, authority, targetId);
    else if (!(await loadAuthority(tx, r.communityId, targetId))) throw notFound("That person is not a member.");
    const beforeVoice = await captureVoiceCapabilities(tx, { communityId: r.communityId });
    if (assigned) {
      await tx.insert(memberRole).values({ communityId: r.communityId, userId: targetId, roleId }).onConflictDoNothing();
    } else {
      await tx.delete(memberRole).where(and(eq(memberRole.roleId, roleId), eq(memberRole.userId, targetId)));
    }
    await invalidateLostVoiceCapabilities(tx, beforeVoice);
    await tx.insert(auditLog).values({
      communityId: r.communityId,
      actorId,
      action: assigned ? "role.assign" : "role.unassign",
      targetId,
      reason: r.name,
    });
    return r.communityId;
  }).then(afterAccessChange);
}

// --- Audit log --------------------------------------------------------------

export interface AuditEntry {
  id: string;
  action: string;
  actorName: string | null;
  targetId: string | null;
  targetName: string | null;
  reason: string | null;
  createdAt: Date;
}

export async function listAuditLog(actorId: string, rawCommunityId: unknown): Promise<AuditEntry[]> {
  const communityId = parse(uuid, rawCommunityId);
  await requireMember(db, communityId, actorId, Permission.ViewAuditLog);
  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorName: user.name,
      targetId: auditLog.targetId,
      reason: auditLog.reason,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(user, eq(user.id, auditLog.actorId))
    .where(eq(auditLog.communityId, communityId))
    .orderBy(desc(auditLog.id))
    .limit(100);
  const targetIds = [...new Set(rows.map((r) => r.targetId).filter((t): t is string => t !== null))];
  const names = targetIds.length
    ? await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, targetIds))
    : [];
  return rows.map((r) => ({ ...r, targetName: names.find((n) => n.id === r.targetId)?.name ?? null }));
}
