import { and, count, countDistinct, desc, eq, gt, inArray, isNotNull, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, channel, message, reaction, user, userBlock } from "@/db/schema";
import { channelAuthorities, loadMember, requireChannel } from "./access";
import { enforceAutomod } from "./automod";
import { attachmentIds, attachmentsFor, linkAttachments, sweepAttachments, type AttachmentView } from "./media";
import { AppError, forbidden, notFound } from "./errors";
import { mentionsFor, syncMentions, type MentionView } from "./mentions";
import { emoji, MAX_EMOJIS_PER_MESSAGE, reactionsFor, replyPreviews, type ReactionView, type ReplyPreview } from "./message-extras";
import { consume } from "./limits";
import { has, Permission } from "./permissions";
import { publish } from "./realtime";
import { messageContent, parse, uuid } from "./validation";

export const PAGE_SIZE = 50;
/** Sliding-window limit per author across all channels; counted in Postgres so it holds across replicas. */
export const RATE_LIMIT = { messages: 5, windowSeconds: 5 };

export interface MessageView {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachments: AttachmentView[];
  mentions: MentionView[];
  replyTo: ReplyPreview | null;
  reactions: ReactionView[];
  pinned: boolean;
}

const viewColumns = {
  id: message.id,
  channelId: message.channelId,
  authorId: message.authorId,
  authorName: user.name,
  content: message.content,
  createdAt: message.createdAt,
  editedAt: message.editedAt,
  replyToId: message.replyToId,
  pinnedAt: message.pinnedAt,
};

interface MessageRow extends Pick<MessageView, "id" | "channelId" | "authorId" | "authorName" | "content"> {
  createdAt: Date;
  editedAt: Date | null;
  replyToId: string | null;
  pinnedAt: Date | null;
}
async function toViews(rows: MessageRow[]): Promise<MessageView[]> {
  const ids = rows.map((r) => r.id);
  const parents = [...new Set(rows.map((r) => r.replyToId).filter((id): id is string => id !== null))];
  const [attachments, mentions, reactions, replies] = await Promise.all([
    attachmentsFor(ids),
    mentionsFor(ids),
    reactionsFor(ids),
    replyPreviews(parents),
  ]);
  return rows.map(({ replyToId, pinnedAt, ...r }) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    editedAt: r.editedAt?.toISOString() ?? null,
    attachments: attachments.get(r.id) ?? [],
    mentions: mentions.get(r.id) ?? [],
    replyTo: replyToId ? (replies.get(replyToId) ?? null) : null,
    reactions: reactions.get(r.id) ?? [],
    pinned: pinnedAt !== null,
  }));
}

async function notifyMentions(userIds: string[], communityId: string, channelId: string, messageId: string) {
  for (const userId of userIds) await publish({ type: "mention.created", userId, communityId, channelId, messageId });
}

export interface MessagePage {
  /** Oldest first. */
  messages: MessageView[];
  hasMore: boolean;
}

/** Newest page, or the page before `before` (a message id; UUIDv7 sorts by time). */
export async function listMessages(userId: string, rawChannelId: unknown, rawBefore?: unknown): Promise<MessagePage> {
  const channelId = parse(uuid, rawChannelId);
  const before = rawBefore ? parse(uuid, rawBefore) : undefined;
  await requireChannel(db, channelId, userId);
  const rows = await db
    .select(viewColumns)
    .from(message)
    .innerJoin(user, eq(user.id, message.authorId))
    .where(before ? and(eq(message.channelId, channelId), lt(message.id, before)) : eq(message.channelId, channelId))
    .orderBy(desc(message.id))
    .limit(PAGE_SIZE + 1);
  return { messages: await toViews(rows.slice(0, PAGE_SIZE).reverse()), hasMore: rows.length > PAGE_SIZE };
}

/**
 * One message with its community, without an access check. Only for the realtime fan-out, which
 * checks membership per stream (on connect, on removal events and after every resync).
 */
export async function getMessageForBroadcast(messageId: string): Promise<{ communityId: string; message: MessageView } | null> {
  const [row] = await db
    .select({ ...viewColumns, communityId: channel.communityId })
    .from(message)
    .innerJoin(user, eq(user.id, message.authorId))
    .innerJoin(channel, eq(channel.id, message.channelId))
    .where(eq(message.id, messageId));
  if (!row) return null;
  const { communityId, ...view } = row;
  return { communityId, message: (await toViews([view]))[0] };
}

export async function sendMessage(
  userId: string,
  rawChannelId: unknown,
  rawContent: unknown,
  rawAttachments: unknown = [],
  rawReplyToId: unknown = null,
): Promise<MessageView> {
  const channelId = parse(uuid, rawChannelId);
  const replyToId = rawReplyToId ? parse(uuid, rawReplyToId) : null;
  const ids = parse(attachmentIds, rawAttachments);
  // A message with images may have no text.
  const content = ids.length > 0 && typeof rawContent === "string" && !rawContent.trim() ? "" : parse(messageContent, rawContent);
  const { channel: ch, authority } = await requireChannel(db, channelId, userId, Permission.SendMessages);
  await enforceAutomod(ch.communityId, userId, authority, content);

  const since = new Date(Date.now() - RATE_LIMIT.windowSeconds * 1000);
  const [{ recent }] = await db
    .select({ recent: count() })
    .from(message)
    .where(and(eq(message.authorId, userId), gt(message.createdAt, since)));
  if (recent >= RATE_LIMIT.messages) throw new AppError("rate_limited", "You're sending messages too quickly. Wait a moment.");

  if (replyToId) {
    // Replies stay inside one channel, so a preview can never come from a channel the reader can't see.
    const [parent] = await db.select({ id: message.id }).from(message).where(and(eq(message.id, replyToId), eq(message.channelId, channelId)));
    if (!parent) throw notFound("The message you replied to was deleted.");
  }
  const { row, mentioned } = await db.transaction(async (tx) => {
    const [created] = await tx.insert(message).values({ channelId, authorId: userId, content, replyToId }).returning();
    await linkAttachments(tx, userId, channelId, created.id, ids);
    return { row: created, mentioned: await syncMentions(tx, ch.communityId, created.id, userId, content) };
  });
  const [author] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  await publish({ type: "message.created", communityId: ch.communityId, channelId, messageId: row.id });
  await notifyMentions(mentioned, ch.communityId, channelId, row.id);
  return (await toViews([{ ...row, authorName: author.name }]))[0];
}

async function loadOwnedMessage(rawMessageId: unknown) {
  const messageId = parse(uuid, rawMessageId);
  const [row] = await db
    .select({ message, communityId: channel.communityId })
    .from(message)
    .innerJoin(channel, eq(channel.id, message.channelId))
    .where(eq(message.id, messageId));
  if (!row) throw notFound("Message not found.");
  return row;
}

export async function editMessage(userId: string, rawMessageId: unknown, rawContent: unknown) {
  const content = parse(messageContent, rawContent);
  const row = await loadOwnedMessage(rawMessageId);
  // Muted members (no SendMessages) can't rewrite their history either.
  const { authority } = await requireChannel(db, row.message.channelId, userId, Permission.SendMessages);
  if (row.message.authorId !== userId) throw forbidden("You can only edit your own messages.");
  await enforceAutomod(row.communityId, userId, authority, content);
  // Edits update who is mentioned but never notify: otherwise editing a mention out and back in re-pings.
  await db.transaction(async (tx) => {
    await tx.update(message).set({ content, editedAt: new Date() }).where(eq(message.id, row.message.id));
    await syncMentions(tx, row.communityId, row.message.id, userId, content);
  });
  await publish({ type: "message.updated", communityId: row.communityId, channelId: row.message.channelId, messageId: row.message.id });
}

export async function deleteMessage(userId: string, rawMessageId: unknown) {
  const row = await loadOwnedMessage(rawMessageId);
  const { authority } = await requireChannel(db, row.message.channelId, userId);
  const own = row.message.authorId === userId;
  if (!own && !has(authority, Permission.ManageMessages)) throw forbidden("You can only delete your own messages.");
  await db.transaction(async (tx) => {
    await tx.delete(message).where(eq(message.id, row.message.id));
    // Moderator deletions are audited, without the content.
    if (!own) {
      await tx.insert(auditLog).values({
        communityId: row.communityId,
        actorId: userId,
        action: "message.delete",
        targetId: row.message.authorId,
      });
    }
  });
  await publish({ type: "message.deleted", communityId: row.communityId, channelId: row.message.channelId, messageId: row.message.id });
  // Free its images now; other deletions (channel, community, account) are caught by the periodic sweep.
  void sweepAttachments().catch((error: unknown) => console.error("[media] sweep failed", error));
}

// --- Reactions and pins -----------------------------------------------------

/** Adds or removes the caller's reaction. Reacting needs the same permission as writing. */
export async function toggleReaction(userId: string, rawMessageId: unknown, rawEmoji: unknown): Promise<void> {
  const value = parse(emoji, rawEmoji);
  // Every toggle re-sends the message to all viewers, so it gets its own burst limit.
  consume(`reaction:${userId}`, 10, 10_000);
  const row = await loadOwnedMessage(rawMessageId);
  await requireChannel(db, row.message.channelId, userId, Permission.SendMessages);
  await db.transaction(async (tx) => {
    // Serialise per message so the distinct-emoji cap can't be raced.
    await tx.execute(sql`select 1 from ${message} where ${message.id} = ${row.message.id} for update`);
    const removed = await tx.delete(reaction)
      .where(and(eq(reaction.messageId, row.message.id), eq(reaction.userId, userId), eq(reaction.emoji, value)))
      .returning({ emoji: reaction.emoji });
    if (removed.length > 0) return;
    const [{ emojis }] = await tx.select({ emojis: countDistinct(reaction.emoji) }).from(reaction).where(eq(reaction.messageId, row.message.id));
    const [{ existing }] = await tx.select({ existing: count() }).from(reaction)
      .where(and(eq(reaction.messageId, row.message.id), eq(reaction.emoji, value)));
    if (existing === 0 && emojis >= MAX_EMOJIS_PER_MESSAGE) throw new AppError("conflict", `A message can have at most ${MAX_EMOJIS_PER_MESSAGE} different reactions.`);
    await tx.insert(reaction).values({ messageId: row.message.id, userId, emoji: value });
  });
  await publish({ type: "message.updated", communityId: row.communityId, channelId: row.message.channelId, messageId: row.message.id });
}

export const MAX_PINS_PER_CHANNEL = 50;

export async function setPinned(userId: string, rawMessageId: unknown, pinned: boolean): Promise<void> {
  const row = await loadOwnedMessage(rawMessageId);
  await requireChannel(db, row.message.channelId, userId, Permission.ManageMessages);
  await db.transaction(async (tx) => {
    if (pinned && !row.message.pinnedAt) {
      // Serialise pins per channel so concurrent pins can't pass the cap.
      await tx.execute(sql`select 1 from ${channel} where ${channel.id} = ${row.message.channelId} for update`);
      const [{ pins }] = await tx.select({ pins: count() }).from(message)
        .where(and(eq(message.channelId, row.message.channelId), isNotNull(message.pinnedAt)));
      if (pins >= MAX_PINS_PER_CHANNEL) throw new AppError("conflict", `A channel can have at most ${MAX_PINS_PER_CHANNEL} pinned messages.`);
    }
    await tx.update(message).set({ pinnedAt: pinned ? (row.message.pinnedAt ?? new Date()) : null }).where(eq(message.id, row.message.id));
    await tx.insert(auditLog).values({ communityId: row.communityId, actorId: userId, action: pinned ? "message.pin" : "message.unpin", targetId: row.message.authorId });
  });
  await publish({ type: "message.updated", communityId: row.communityId, channelId: row.message.channelId, messageId: row.message.id });
}

/** Pinned messages of a channel, newest pin first. */
export async function listPinned(userId: string, rawChannelId: unknown): Promise<MessageView[]> {
  const channelId = parse(uuid, rawChannelId);
  await requireChannel(db, channelId, userId);
  const rows = await db
    .select(viewColumns)
    .from(message)
    .innerJoin(user, eq(user.id, message.authorId))
    .where(and(eq(message.channelId, channelId), isNotNull(message.pinnedAt)))
    .orderBy(desc(message.pinnedAt))
    .limit(MAX_PINS_PER_CHANNEL);
  return toViews(rows);
}

// --- Search -----------------------------------------------------------------

export const SEARCH_LIMIT = 25;

/** Words of a query as a prefix tsquery ("hel wor" → "hel:* & wor:*"); only letters and digits pass. */
export function toPrefixQuery(q: string): string | null {
  const words = (q.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  return words.length ? words.map((w) => `${w}:*`).join(" & ") : null;
}

export interface SearchResult extends MessageView {
  channelName: string;
}

/**
 * Full-text search over the channels of one community that the person can read, newest first.
 * Messages from people they blocked are left out.
 */
export async function searchMessages(userId: string, rawCommunityId: unknown, rawQuery: unknown, rawBefore?: unknown): Promise<SearchResult[]> {
  const communityId = parse(uuid, rawCommunityId);
  const query = toPrefixQuery(parse(z.string().max(200), rawQuery ?? ""));
  const before = rawBefore ? parse(uuid, rawBefore) : undefined;
  const ctx = await loadMember(db, communityId, userId);
  if (!ctx) throw notFound("Community not found.");
  if (!query) return [];
  const channels = await db.select({ id: channel.id, name: channel.name }).from(channel).where(eq(channel.communityId, communityId));
  const perms = await channelAuthorities(db, ctx, channels.map((c) => c.id));
  const readable = channels.filter((c) => has(perms.get(c.id)!, Permission.ViewChannels));
  if (readable.length === 0) return [];
  const rows = await db
    .select(viewColumns)
    .from(message)
    .innerJoin(user, eq(user.id, message.authorId))
    .where(
      and(
        inArray(message.channelId, readable.map((c) => c.id)),
        sql`${message.search} @@ to_tsquery('simple', ${query})`,
        notExists(db.select().from(userBlock).where(and(eq(userBlock.blockerId, userId), eq(userBlock.blockedId, message.authorId)))),
        before ? lt(message.id, before) : undefined,
      ),
    )
    .orderBy(desc(message.id))
    .limit(SEARCH_LIMIT);
  const names = new Map(readable.map((c) => [c.id, c.name]));
  return (await toViews(rows)).map((m) => ({ ...m, channelName: names.get(m.channelId) ?? "" }));
}
