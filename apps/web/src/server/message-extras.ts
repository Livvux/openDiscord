// Read-side extras of a message view: reactions and the preview of the message it replies to.
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { message, reaction, user } from "@/db/schema";
import { mentionsFor } from "./mentions";

export interface ReactionView {
  emoji: string;
  /** Who reacted, oldest first; the client derives the count and "you reacted". */
  userIds: string[];
}

export interface ReplyPreview {
  id: string;
  authorId: string;
  authorName: string;
  excerpt: string;
}

export const MAX_EMOJIS_PER_MESSAGE = 20;
const EXCERPT_LENGTH = 100;

/** One emoji: pictographs with optional variation selectors, skin tones and ZWJ sequences. No text. */
export const emoji = z
  .string()
  .max(32)
  .regex(/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9])+$/u, "Pick an emoji.")
  .refine((s) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s), "Pick an emoji.");

export async function reactionsFor(messageIds: string[]): Promise<Map<string, ReactionView[]>> {
  const byMessage = new Map<string, ReactionView[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select({ messageId: reaction.messageId, emoji: reaction.emoji, userId: reaction.userId })
    .from(reaction)
    .where(inArray(reaction.messageId, messageIds))
    .orderBy(asc(reaction.createdAt));
  for (const r of rows) {
    const list = byMessage.get(r.messageId) ?? [];
    const entry = list.find((e) => e.emoji === r.emoji);
    if (entry) entry.userIds.push(r.userId);
    else list.push({ emoji: r.emoji, userIds: [r.userId] });
    byMessage.set(r.messageId, list);
  }
  return byMessage;
}

/** Previews of replied-to messages. Callers only pass ids from the same channel as the replies. */
export async function replyPreviews(ids: string[]): Promise<Map<string, ReplyPreview>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: message.id, authorId: message.authorId, authorName: user.name, content: message.content })
    .from(message)
    .innerJoin(user, eq(user.id, message.authorId))
    .where(inArray(message.id, ids));
  const mentions = await mentionsFor(rows.map((r) => r.id));
  return new Map(
    rows.map(({ content, ...r }) => {
      const names = new Map((mentions.get(r.id) ?? []).map((m) => [m.id, m.name]));
      const text = content.replace(/<@([A-Za-z0-9_-]+)>/g, (_, id: string) => `@${names.get(id) ?? "member"}`);
      return [r.id, { ...r, excerpt: text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text }];
    }),
  );
}
