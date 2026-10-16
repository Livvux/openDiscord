import { isUnicodeEmoji } from "@/lib/emoji";
import { ASSET_TOKEN_SOURCE, assetTokens, type AssetView } from "@/lib/community-assets";
import { assetsForMessages } from "./community-assets";
// Read-side extras of a message view: reactions and the preview of the message it replies to.
import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { message, reaction, user } from "@/db/schema";
import { excerptOf } from "@/lib/mentions";
import { mentionsFor } from "./mentions";

export interface ReactionView {
  emoji: string;
  asset?: AssetView;
  /** Who reacted, oldest first; the client derives the count and "you reacted". */
  userIds: string[];
}

export interface ReplyPreview {
  id: string;
  authorId: string;
  authorName: string;
  /** The original author of an imported message (the name isn't an account here). */
  authorImported: boolean;
  excerpt: string;
}

export const MAX_EMOJIS_PER_MESSAGE = 20;
export const REPLY_EXCERPT_LENGTH = 100;

/** Exactly one supported Unicode emoji, including flags and mixed skin-tone sequences. */
const unicodeEmoji = z.string().max(64).refine(isUnicodeEmoji, "Pick an emoji.");

export const emoji = z.union([unicodeEmoji, z.string().regex(new RegExp(`^${ASSET_TOKEN_SOURCE}$`)).refine((value) => assetTokens(value)[0]?.kind === "emoji", "Pick an emoji.")]);

export async function reactionsFor(messageIds: string[]): Promise<Map<string, ReactionView[]>> {
  const byMessage = new Map<string, ReactionView[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select({ messageId: reaction.messageId, emoji: reaction.emoji, userId: reaction.userId, channelId: message.channelId })
    .from(reaction)
    .innerJoin(message, eq(message.id, reaction.messageId))
    .where(inArray(reaction.messageId, messageIds))
    .orderBy(asc(reaction.createdAt));
  const assets = await assetsForMessages(rows.map((r, index) => ({ id: String(index), channelId: r.channelId, content: r.emoji })));
  for (const [index, r] of rows.entries()) {
    const list = byMessage.get(r.messageId) ?? [];
    const entry = list.find((e) => e.emoji === r.emoji);
    if (entry) entry.userIds.push(r.userId);
    else list.push({ emoji: r.emoji, userIds: [r.userId], ...(assets.get(String(index))?.[0] ? { asset: assets.get(String(index))![0] } : {}) });
    byMessage.set(r.messageId, list);
  }
  return byMessage;
}

/** Previews of replied-to messages. Callers only pass ids from the same channel as the replies. */
export async function replyPreviews(ids: string[]): Promise<Map<string, ReplyPreview>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: message.id, authorId: message.authorId, authorName: sql<string>`coalesce(${message.importedAuthor}, ${user.name})`,
      authorImported: sql<boolean>`${message.importedAuthor} is not null`, content: message.content,
    })
    .from(message)
    .innerJoin(user, eq(user.id, message.authorId))
    .where(inArray(message.id, ids));
  const mentions = await mentionsFor(rows.map((r) => r.id));
  return new Map(rows.map(({ content, ...r }) => [r.id, { ...r, excerpt: excerptOf(content, mentions.get(r.id) ?? [], REPLY_EXCERPT_LENGTH) }]));
}
