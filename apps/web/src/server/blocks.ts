// Blocking is personal: the blocked person isn't told, keeps seeing the blocker's messages, and can
// still be seen by everyone else. For the blocker, their messages collapse and their mentions are silent.
import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { user, userBlock } from "@/db/schema";
import { enforceCap } from "./limits";
import { invalid, notFound } from "./errors";
import { parse } from "./validation";

export const MAX_BLOCKS = 1000;
const userId = z.string().min(1).max(64);

export interface BlockedUser {
  id: string;
  name: string;
  createdAt: Date;
}

export async function blockUser(actorId: string, rawTargetId: unknown): Promise<void> {
  const targetId = parse(userId, rawTargetId);
  if (targetId === actorId) throw invalid("You can't block yourself.");
  const [target] = await db.select({ id: user.id }).from(user).where(eq(user.id, targetId));
  if (!target) throw notFound("Account not found.");
  const [{ total }] = await db.select({ total: count() }).from(userBlock).where(eq(userBlock.blockerId, actorId));
  enforceCap(total, MAX_BLOCKS, `You can block at most ${MAX_BLOCKS} people.`);
  await db.insert(userBlock).values({ blockerId: actorId, blockedId: targetId }).onConflictDoNothing();
}

export async function unblockUser(actorId: string, rawTargetId: unknown): Promise<void> {
  const targetId = parse(userId, rawTargetId);
  await db.delete(userBlock).where(and(eq(userBlock.blockerId, actorId), eq(userBlock.blockedId, targetId)));
}

export async function listBlocked(actorId: string): Promise<BlockedUser[]> {
  return db
    .select({ id: user.id, name: user.name, createdAt: userBlock.createdAt })
    .from(userBlock)
    .innerJoin(user, eq(user.id, userBlock.blockedId))
    .where(eq(userBlock.blockerId, actorId))
    .orderBy(asc(user.name));
}

export async function blockedIds(actorId: string): Promise<string[]> {
  const rows = await db.select({ id: userBlock.blockedId }).from(userBlock).where(eq(userBlock.blockerId, actorId));
  return rows.map((r) => r.id);
}
