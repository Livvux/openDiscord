// Channel categories: sidebar groups managed with "Manage channels". A category can also carry role
// overrides that its channels inherit (src/server/access.ts `effectiveOverrides`), so anything that
// changes which overrides a channel inherits needs role management too and re-checks Voice.
import { and, asc, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, category, categoryOverride, channel, role } from "@/db/schema";
import { channelAuthorities, loadMember, lockCommunity, requireChannel, requireMember, type Db } from "./access";
import type { ChannelOverrideView } from "./communities";
import { enforceCap } from "./limits";
import { forbidden, invalid, notFound } from "./errors";
import { canManageRole, CHANNEL_PERMISSIONS, has, Permission } from "./permissions";
import { publish } from "./realtime";
import { afterAccessChange } from "./voice";
import { captureVoiceCapabilities, invalidateLostVoiceCapabilities } from "./voice-control";
import { lockVoiceLifecycle } from "./voice-locks";
import { voiceTransaction } from "./voice-sfu";
import { parse, uuid } from "./validation";

export const MAX_CATEGORIES = 50;
const categoryName = z.string().trim().min(1, "Give the category a name.").max(32, "Use at most 32 characters.");
const overrideBits = z.number().int().min(0).max(CHANNEL_PERMISSIONS).refine((n) => (n & ~CHANNEL_PERMISSIONS) === 0, "Unknown permission.");
const MANAGE_ACCESS = Permission.ManageChannels | Permission.ManageRoles;

export interface CategorySummary {
  id: string;
  name: string;
}

export async function listCategories(communityId: string): Promise<CategorySummary[]> {
  return db
    .select({ id: category.id, name: category.name })
    .from(category)
    .where(eq(category.communityId, communityId))
    .orderBy(asc(category.position), asc(category.id));
}

export async function createCategory(userId: string, rawCommunityId: unknown, rawName: unknown): Promise<string> {
  const communityId = parse(uuid, rawCommunityId);
  const name = parse(categoryName, rawName);
  const id = await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    await requireMember(tx, communityId, userId, Permission.ManageChannels);
    const [{ total }] = await tx.select({ total: count() }).from(category).where(eq(category.communityId, communityId));
    enforceCap(total, MAX_CATEGORIES, `A community can have at most ${MAX_CATEGORIES} categories.`);
    const [created] = await tx
      .insert(category)
      .values({
        communityId,
        name,
        position: sql`(select coalesce(max(${category.position}), 0) + 1 from ${category} where ${category.communityId} = ${communityId})`,
      })
      .returning({ id: category.id });
    await tx.insert(auditLog).values({ communityId, actorId: userId, action: "category.create", targetId: name });
    return created.id;
  });
  await publish({ type: "channels.changed", communityId });
  return id;
}

async function requireCategory(userId: string, rawId: unknown, database: Db = db, permission: number = Permission.ManageChannels) {
  const id = parse(uuid, rawId);
  const [row] = await database.select().from(category).where(eq(category.id, id));
  if (!row) throw notFound("Category not found.");
  const access = await requireMember(database, row.communityId, userId, permission);
  return { ...row, authority: access.authority };
}

async function hasOverrides(tx: Db, categoryId: string | null): Promise<boolean> {
  if (!categoryId) return false;
  const [row] = await tx.select({ roleId: categoryOverride.roleId }).from(categoryOverride).where(eq(categoryOverride.categoryId, categoryId)).limit(1);
  return !!row;
}

/** Changing what a category passes down must not reach channels the actor can't see themselves. */
async function requireSeesEveryChannel(tx: Db, communityId: string, categoryId: string, userId: string) {
  const ctx = await loadMember(tx, communityId, userId);
  if (!ctx) throw notFound("Category not found.");
  const ids = (await tx.select({ id: channel.id }).from(channel).where(eq(channel.categoryId, categoryId))).map((c) => c.id);
  const perms = await channelAuthorities(tx, ctx, ids);
  if (ids.some((id) => !has(perms.get(id)!, Permission.ViewChannels))) throw forbidden();
}

export async function renameCategory(userId: string, rawId: unknown, rawName: unknown): Promise<void> {
  const name = parse(categoryName, rawName);
  const row = await requireCategory(userId, rawId);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, row.communityId);
    const current = await requireCategory(userId, row.id, tx);
    await tx.update(category).set({ name }).where(eq(category.id, row.id));
    await tx.insert(auditLog).values({ communityId: row.communityId, actorId: userId, action: "category.rename", targetId: name, reason: current.name });
  });
  await publish({ type: "channels.changed", communityId: row.communityId });
}

/** Deletes the group only; its channels become uncategorised and stop inheriting its overrides. */
export async function deleteCategory(userId: string, rawId: unknown): Promise<void> {
  const row = await requireCategory(userId, rawId);
  await voiceTransaction(async (tx) => {
    await lockVoiceLifecycle(tx);
    await lockCommunity(tx, row.communityId);
    const current = await requireCategory(userId, row.id, tx);
    if (await hasOverrides(tx, row.id)) {
      if (!has(current.authority, MANAGE_ACCESS)) throw forbidden();
      await requireSeesEveryChannel(tx, row.communityId, row.id, userId);
    }
    const beforeVoice = await captureVoiceCapabilities(tx, { communityId: row.communityId });
    await tx.delete(category).where(eq(category.id, row.id));
    await invalidateLostVoiceCapabilities(tx, beforeVoice);
    await tx.insert(auditLog).values({ communityId: row.communityId, actorId: userId, action: "category.delete", targetId: current.name });
  });
  await publish({ type: "channels.changed", communityId: row.communityId });
  await afterAccessChange(row.communityId);
}

export async function setChannelCategory(userId: string, rawChannelId: unknown, rawCategoryId: unknown): Promise<void> {
  const channelId = parse(uuid, rawChannelId);
  const categoryId = rawCategoryId ? parse(uuid, rawCategoryId) : null;
  const { channel: ch } = await requireChannel(db, channelId, userId, Permission.ManageChannels);
  await voiceTransaction(async (tx) => {
    await lockVoiceLifecycle(tx);
    await lockCommunity(tx, ch.communityId);
    const { channel: current } = await requireChannel(tx, channelId, userId, Permission.ManageChannels);
    if (current.categoryId === categoryId) return;
    if (categoryId) {
      const [target] = await tx.select({ id: category.id }).from(category)
        .where(and(eq(category.id, categoryId), eq(category.communityId, ch.communityId)));
      if (!target) throw notFound("Category not found.");
    }
    // Moving between categories with overrides changes who can see and join the channel.
    if ((await hasOverrides(tx, current.categoryId)) || (await hasOverrides(tx, categoryId))) {
      await requireChannel(tx, channelId, userId, MANAGE_ACCESS);
    }
    const beforeVoice = await captureVoiceCapabilities(tx, { channelId });
    await tx.update(channel).set({ categoryId }).where(eq(channel.id, channelId));
    await invalidateLostVoiceCapabilities(tx, beforeVoice);
  });
  await publish({ type: "channels.changed", communityId: ch.communityId });
  await afterAccessChange(ch.communityId);
}

/** Every role of the category's community with its category override (0/0 when none). */
export async function listCategoryOverrides(userId: string, rawId: unknown): Promise<ChannelOverrideView[]> {
  const row = await requireCategory(userId, rawId, db, MANAGE_ACCESS);
  const rows = await db
    .select({ roleId: role.id, roleName: role.name, position: role.position, isDefault: role.isDefault, allow: categoryOverride.allow, deny: categoryOverride.deny })
    .from(role)
    .leftJoin(categoryOverride, and(eq(categoryOverride.roleId, role.id), eq(categoryOverride.categoryId, row.id)))
    .where(eq(role.communityId, row.communityId))
    .orderBy(asc(role.position), asc(role.id));
  return rows.map((r) => ({ ...r, allow: r.allow ?? 0, deny: r.deny ?? 0 }));
}

export async function setCategoryOverride(userId: string, rawId: unknown, rawRoleId: unknown, rawAllow: unknown, rawDeny: unknown): Promise<void> {
  const roleId = parse(uuid, rawRoleId);
  const allow = parse(overrideBits, rawAllow);
  const deny = parse(overrideBits, rawDeny);
  if (allow & deny) throw invalid("A permission can't be both allowed and denied.");
  const row = await requireCategory(userId, rawId, db, MANAGE_ACCESS);
  await voiceTransaction(async (tx) => {
    await lockVoiceLifecycle(tx);
    await lockCommunity(tx, row.communityId);
    const current = await requireCategory(userId, row.id, tx, MANAGE_ACCESS);
    await requireSeesEveryChannel(tx, row.communityId, row.id, userId);
    const [r] = await tx.select().from(role).where(and(eq(role.id, roleId), eq(role.communityId, row.communityId)));
    if (!r) throw notFound("Role not found.");
    // Same escalation rule as channel overrides: only roles below you, only bits you hold.
    if (!canManageRole(current.authority, r.position, allow | deny) || !has(current.authority, allow | deny)) throw forbidden();
    const beforeVoice = await captureVoiceCapabilities(tx, { communityId: row.communityId });
    if (allow === 0 && deny === 0) {
      await tx.delete(categoryOverride).where(and(eq(categoryOverride.categoryId, row.id), eq(categoryOverride.roleId, roleId)));
    } else {
      await tx.insert(categoryOverride).values({ categoryId: row.id, roleId, allow, deny })
        .onConflictDoUpdate({ target: [categoryOverride.categoryId, categoryOverride.roleId], set: { allow, deny } });
    }
    await invalidateLostVoiceCapabilities(tx, beforeVoice);
    await tx.insert(auditLog).values({ communityId: row.communityId, actorId: userId, action: "category.permissions", targetId: current.name, reason: r.name });
  });
  await publish({ type: "channels.changed", communityId: row.communityId });
  await afterAccessChange(row.communityId);
}
