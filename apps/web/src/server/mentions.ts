// Mentions are stored in message content as `<@userId>` so renames don't break them, and indexed in
// the `mention` table for unread counts and notifications.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { member, mention, user, userBlock } from "@/db/schema";
import type { Db } from "./access";

export interface MentionView {
  id: string;
  name: string;
}

/** Bounds the work one message can cause (lookups, notifications). */
export const MAX_MENTIONS = 20;
const TOKEN = /<@([A-Za-z0-9_-]{1,64})>/g;

/** Distinct user ids mentioned in `content`, in order, at most MAX_MENTIONS. */
export function parseMentionIds(content: string): string[] {
  return [...new Set([...content.matchAll(TOKEN)].map((m) => m[1]))].slice(0, MAX_MENTIONS);
}

/**
 * Replaces the message's mentions with the community members its content names (never the author).
 * Returns the ids that are mentioned now but weren't before and haven't blocked the author: the ones to notify.
 */
export async function syncMentions(tx: Db, communityId: string, messageId: string, authorId: string, content: string): Promise<string[]> {
  const ids = parseMentionIds(content).filter((id) => id !== authorId);
  const before = (await tx.select({ userId: mention.userId }).from(mention).where(eq(mention.messageId, messageId))).map((r) => r.userId);
  await tx.delete(mention).where(eq(mention.messageId, messageId));
  if (ids.length === 0) return [];
  const members = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.communityId, communityId), inArray(member.userId, ids)));
  if (members.length === 0) return [];
  await tx.insert(mention).values(members.map((m) => ({ messageId, userId: m.userId })));
  const fresh = members.map((m) => m.userId).filter((id) => !before.includes(id));
  if (fresh.length === 0) return [];
  // People who blocked the author still see their name rendered, but aren't notified.
  const blockers = await tx
    .select({ id: userBlock.blockerId })
    .from(userBlock)
    .where(and(eq(userBlock.blockedId, authorId), inArray(userBlock.blockerId, fresh)));
  return fresh.filter((id) => !blockers.some((b) => b.id === id));
}

export async function mentionsFor(messageIds: string[]): Promise<Map<string, MentionView[]>> {
  const byMessage = new Map<string, MentionView[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select({ messageId: mention.messageId, id: user.id, name: user.name })
    .from(mention)
    .innerJoin(user, eq(user.id, mention.userId))
    .where(inArray(mention.messageId, messageIds));
  for (const { messageId, ...view } of rows) byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), view]);
  return byMessage;
}
