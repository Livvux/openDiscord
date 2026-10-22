// Channel categories: sidebar groups managed with "Manage channels". They carry no permissions of their
// own (channel overrides do that), so moving a channel never changes who can see it.
import { and, asc, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, category, channel } from "@/db/schema";
import { lockCommunity, requireChannel, requireMember, type Db } from "./access";
import { enforceCap } from "./limits";
import { notFound } from "./errors";
import { Permission } from "./permissions";
import { publish } from "./realtime";
import { parse, uuid } from "./validation";

export const MAX_CATEGORIES = 50;
const categoryName = z.string().trim().min(1, "Give the category a name.").max(32, "Use at most 32 characters.");

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

async function requireCategory(userId: string, rawId: unknown, database: Db = db) {
  const id = parse(uuid, rawId);
  const [row] = await database.select().from(category).where(eq(category.id, id));
  if (!row) throw notFound("Category not found.");
  await requireMember(database, row.communityId, userId, Permission.ManageChannels);
  return row;
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

/** Deletes the group only; its channels become uncategorised. */
export async function deleteCategory(userId: string, rawId: unknown): Promise<void> {
  const row = await requireCategory(userId, rawId);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, row.communityId);
    const current = await requireCategory(userId, row.id, tx);
    await tx.delete(category).where(eq(category.id, row.id));
    await tx.insert(auditLog).values({ communityId: row.communityId, actorId: userId, action: "category.delete", targetId: current.name });
  });
  await publish({ type: "channels.changed", communityId: row.communityId });
}

export async function setChannelCategory(userId: string, rawChannelId: unknown, rawCategoryId: unknown): Promise<void> {
  const channelId = parse(uuid, rawChannelId);
  const categoryId = rawCategoryId ? parse(uuid, rawCategoryId) : null;
  const { channel: ch } = await requireChannel(db, channelId, userId, Permission.ManageChannels);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, ch.communityId);
    await requireChannel(tx, channelId, userId, Permission.ManageChannels);
    if (categoryId) {
      const [target] = await tx.select({ id: category.id }).from(category)
        .where(and(eq(category.id, categoryId), eq(category.communityId, ch.communityId)));
      if (!target) throw notFound("Category not found.");
    }
    await tx.update(channel).set({ categoryId }).where(eq(channel.id, channelId));
  });
  await publish({ type: "channels.changed", communityId: ch.communityId });
}
