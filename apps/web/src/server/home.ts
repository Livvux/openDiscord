// The personal Home: what needs your attention across private messages, friends and communities.
import { inArray, max } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import { dmMessage } from "@/db/schema";
import type { DirectConversation } from "@/lib/dm/contracts";
import { listDirectConversations } from "./direct-messages";
import { listFriends } from "./friends";

export type RecentConversation = DirectConversation & { lastActivity: string | null };

/** Conversations by latest message (metadata only: content stays encrypted), newest first. */
async function recentConversations(userId: string, limit = 50): Promise<{ recent: RecentConversation[]; incomingRequests: number }> {
  const all = await listDirectConversations(userId);
  const visible = all.filter((c) => c.status !== "rejected" && !c.ownBlocked);
  const incomingRequests = visible.filter((c) => c.status === "pending" && c.requestedBy !== userId).length;
  if (!visible.length) return { recent: [], incomingRequests };
  const latest = await db
    .select({ id: dmMessage.conversationId, at: max(dmMessage.createdAt) })
    .from(dmMessage)
    .where(inArray(dmMessage.conversationId, visible.map((c) => c.id)))
    .groupBy(dmMessage.conversationId);
  const at = new Map(latest.map((l) => [l.id, l.at?.toISOString() ?? null]));
  // Conversation ids are UUIDv7, so a conversation without messages sorts by when it was opened.
  const key = (c: RecentConversation) => c.lastActivity ?? "";
  const recent = visible
    .map((c) => ({ ...c, lastActivity: at.get(c.id) ?? null }))
    .sort((a, b) => key(b).localeCompare(key(a)) || b.id.localeCompare(a.id))
    .slice(0, limit);
  return { recent, incomingRequests };
}

// The Home layout (sidebar) and its pages render in the same request; load once.
export const homeFriends = cache(listFriends);
export const homeConversations = cache((userId: string) => recentConversations(userId));
