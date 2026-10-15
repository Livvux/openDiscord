import { voiceTransaction } from "./voice-sfu";
import { lockVoiceLifecycle } from "./voice-locks";
import { invalidateBlockedVoicePair } from "./voice-control";
// Blocking is personal: the blocked person isn't told, keeps seeing the blocker's messages, and can
// still be seen by everyone else. For the blocker, their messages collapse and their mentions are silent.
import { and, asc, count, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "@/db";
import { dmConversation, member, user, userBlock } from "@/db/schema";
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
  await voiceTransaction(async tx => {
    await lockVoiceLifecycle(tx);
    // Shared membership or an existing private conversation prevents a global account directory.
    const shared = alias(member, "shared");
    const [target] = await tx
      .select({ id: member.userId })
      .from(member)
      .innerJoin(shared, and(eq(shared.communityId, member.communityId), eq(shared.userId, actorId)))
      .where(eq(member.userId, targetId))
      .limit(1);
    const [firstId, secondId] = [actorId, targetId].sort();
    const [conversation] = target ? [] : await tx.select({ id: dmConversation.id }).from(dmConversation).where(and(eq(dmConversation.firstId, firstId), eq(dmConversation.secondId, secondId))).limit(1);
    if (!target && !conversation) throw notFound("Account not found.");
    const [{ total }] = await tx.select({ total: count() }).from(userBlock).where(eq(userBlock.blockerId, actorId));
    enforceCap(total, MAX_BLOCKS, `You can block at most ${MAX_BLOCKS} people.`);
    await tx.insert(userBlock).values({ blockerId: actorId, blockedId: targetId }).onConflictDoNothing();
    await invalidateBlockedVoicePair(tx, actorId, targetId);
  });
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
