import { createHash } from "node:crypto";
import type { AssetView } from "@/lib/community-assets";
import { assetsForMessages, validateCommunityAssetRefs } from "./community-assets";
import { and, count, countDistinct, desc, eq, inArray, isNotNull, isNull, lt, max, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, channel, integration, message, messageSend, publicPost, reaction, user, userBlock } from "@/db/schema";
import { channelAuthorities, loadMember, lockCommunity, requireChannel, type Db } from "./access";
import { enforceAutomod } from "./automod";
import { avatarOf } from "./avatars";
import { attachmentIds, attachmentsFor, linkAttachments, sweepAttachments, type AttachmentView } from "./media";
import { AppError, forbidden, notFound } from "./errors";
import { mentionsFor, syncMentions, type MentionView } from "./mentions";
import { emoji, MAX_EMOJIS_PER_MESSAGE, reactionsFor, replyPreviews, type ReactionView, type ReplyPreview } from "./message-extras";
import { consume } from "./limits";
import { has, Permission } from "./permissions";
import { publish } from "./realtime";
import { messageContent, parse, uuid } from "./validation";

/** How long a typing notice lasts without a refresh (clients re-announce every few seconds). */
const TYPING_TTL_MS = 8000;

import { checkPublicPost, publicText, snapshotPublicPost } from "./public-channels";

export const PAGE_SIZE = 50;
/** Sliding-window limit per author across all channels; counted in Postgres so it holds across replicas. */
export const RATE_LIMIT = { messages: 5, windowSeconds: 5 };

export interface MessageView {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  /** Profile picture id; null without one and for imported authors. */
  authorAvatar: string | null;
  /** Posted by a bot or webhook. */
  authorBot: boolean;
  /** Imported from another instance; `authorName` is the original name. */
  authorImported: boolean;
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachments: AttachmentView[];
  assets: AssetView[];
  mentions: MentionView[];
  replyTo: ReplyPreview | null;
  reactions: ReactionView[];
  pinned: boolean;
  /** The thread root this message belongs to; null for channel messages. */
  threadId: string | null;
  /** Thread summary for roots with replies. */
  thread: { count: number; lastAt: string } | null;
}

const viewColumns = {
  id: message.id,
  channelId: message.channelId,
  authorId: message.authorId,
  // Imported messages show their original author's name.
  authorName: sql<string>`coalesce(${message.importedAuthor}, ${user.name})`,
  authorImported: sql<boolean>`${message.importedAuthor} is not null`,
  authorAvatar: sql<string | null>`case when ${message.importedAuthor} is null then ${avatarOf(message.authorId)} end`,
  authorBot: sql<boolean>`exists (select 1 from ${integration} where ${integration.userId} = ${message.authorId})`,
  content: message.content,
  createdAt: message.createdAt,
  editedAt: message.editedAt,
  replyToId: message.replyToId,
  pinnedAt: message.pinnedAt,
  threadId: message.threadId,
};

interface MessageRow extends Pick<MessageView, "id" | "channelId" | "authorId" | "authorName" | "authorAvatar" | "authorBot" | "authorImported" | "content" | "threadId"> {
  createdAt: Date;
  editedAt: Date | null;
  replyToId: string | null;
  pinnedAt: Date | null;
}
async function toViews(rows: MessageRow[]): Promise<MessageView[]> {
  const ids = rows.map((r) => r.id);
  const parents = [...new Set(rows.map((r) => r.replyToId).filter((id): id is string => id !== null))];
  const roots = rows.filter((r) => r.threadId === null).map((r) => r.id);
  const [attachments, mentions, reactions, replies, threads, assets] = await Promise.all([
    attachmentsFor(ids),
    mentionsFor(ids),
    reactionsFor(ids),
    replyPreviews(parents),
    threadSummaries(roots),
    assetsForMessages(rows),
  ]);
  return rows.map(({ replyToId, pinnedAt, ...r }) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    editedAt: r.editedAt?.toISOString() ?? null,
    attachments: attachments.get(r.id) ?? [],
    assets: assets.get(r.id) ?? [],
    mentions: mentions.get(r.id) ?? [],
    replyTo: replyToId ? (replies.get(replyToId) ?? null) : null,
    reactions: reactions.get(r.id) ?? [],
    pinned: pinnedAt !== null,
    thread: threads.get(r.id) ?? null,
  }));
}

async function threadSummaries(rootIds: string[]): Promise<Map<string, { count: number; lastAt: string }>> {
  if (rootIds.length === 0) return new Map();
  const rows = await db
    .select({ threadId: message.threadId, count: count(), lastAt: max(message.createdAt) })
    .from(message)
    .where(inArray(message.threadId, rootIds))
    .groupBy(message.threadId);
  return new Map(rows.map((r) => [r.threadId!, { count: r.count, lastAt: r.lastAt!.toISOString() }]));
}

/** A thread root: a top-level message of this channel. */
async function requireThreadRoot(channelId: string, rawThreadId: unknown): Promise<string> {
  const threadId = parse(uuid, rawThreadId);
  const [root] = await db.select({ id: message.id }).from(message)
    .where(and(eq(message.id, threadId), eq(message.channelId, channelId), isNull(message.threadId)));
  if (!root) throw notFound("Thread not found.");
  return threadId;
}

function pushMentions(userIds: string[], channelId: string, messageId: string) {
  if (userIds.length === 0) return;
  // Web Push for devices without an open tab; loaded lazily (push imports this module).
  void import("./push")
    .then(({ pushMention }) => Promise.all(userIds.map((userId) => pushMention(userId, channelId, messageId))))
    .catch((error: unknown) => console.error("[push] mention push failed", error));
}

export interface MessagePage {
  /** Oldest first. */
  messages: MessageView[];
  hasMore: boolean;
}

/** Newest page, or the page before `before` (a message id; UUIDv7 sorts by time). */
/** A page of the channel (top-level messages) or, with `rawThreadId`, of one thread. */
export async function listMessages(userId: string, rawChannelId: unknown, rawBefore?: unknown, rawThreadId?: unknown): Promise<MessagePage> {
  const channelId = parse(uuid, rawChannelId);
  const before = rawBefore ? parse(uuid, rawBefore) : undefined;
  const { channel: ch } = await requireChannel(db, channelId, userId);
  if (ch.kind === "voice") return { messages: [], hasMore: false };
  const threadId = rawThreadId ? await requireThreadRoot(channelId, rawThreadId) : null;
  const rows = await db
    .select(viewColumns)
    .from(message)
    .innerJoin(user, eq(user.id, message.authorId))
    .where(and(
      eq(message.channelId, channelId),
      threadId ? eq(message.threadId, threadId) : isNull(message.threadId),
      before ? lt(message.id, before) : undefined,
    ))
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

async function replaySend(database: Db, userId: string, transactionId: string, channelId: string, requestHash: string): Promise<string | undefined> {
  const [receipt] = await database.select().from(messageSend)
    .where(and(eq(messageSend.userId, userId), eq(messageSend.transactionId, transactionId)));
  if (!receipt) return;
  if (receipt.channelId !== channelId || receipt.requestHash !== requestHash) {
    throw new AppError("conflict", "This send ID was already used for a different message.");
  }
  if (!receipt.messageId) throw new AppError("conflict", "This message was already sent and has since been deleted.");
  return receipt.messageId;
}

async function sentMessage(messageId: string): Promise<MessageView> {
  const loaded = await getMessageForBroadcast(messageId);
  if (!loaded) throw notFound("The sent message was deleted.");
  return loaded.message;
}

export async function sendMessage(
  userId: string,
  rawChannelId: unknown,
  rawContent: unknown,
  rawAttachments: unknown = [],
  rawReplyToId: unknown = null,
  rawThreadId: unknown = null,
  publicGeneration: unknown = null,
  rawTransactionId: unknown = null,
): Promise<MessageView> {
  const channelId = parse(uuid, rawChannelId);
  const transactionId = rawTransactionId == null ? null : parse(uuid, rawTransactionId);
  const replyToId = rawReplyToId ? parse(uuid, rawReplyToId) : null;
  const ids = parse(attachmentIds, rawAttachments);
  // A message with images may have no text.
  const content = ids.length > 0 && typeof rawContent === "string" && !rawContent.trim() ? "" : parse(messageContent, rawContent);
  const { channel: ch, authority } = await requireChannel(db, channelId, userId, Permission.SendMessages);
  if (ch.kind === "voice") throw new AppError("invalid", "Voice channels don't have messages.");
  const threadId = rawThreadId ? parse(uuid, rawThreadId) : null;
  const requestHash = createHash("sha256").update(JSON.stringify([channelId, content, ids, replyToId, threadId, publicGeneration ?? null])).digest("hex");
  // Replays still need current access, but mutable new-send rules must not hide a committed send.
  if (transactionId) {
    const replay = await replaySend(db, userId, transactionId, channelId, requestHash);
    if (replay) return sentMessage(replay);
  }
  await enforceAutomod(ch.communityId, userId, authority, content);
  const { messageId, mentioned } = await db.transaction(async (tx) => {
    await lockCommunity(tx, ch.communityId);
    await requireChannel(tx, channelId, userId, Permission.SendMessages);
    if (transactionId) {
      // The unique receipt serializes retries, including requests in different communities.
      const claimed = await tx.insert(messageSend).values({ userId, transactionId, channelId, requestHash })
        .onConflictDoNothing().returning({ transactionId: messageSend.transactionId });
      if (!claimed.length) {
        const replay = await replaySend(tx, userId, transactionId, channelId, requestHash);
        if (!replay) throw new AppError("conflict", "This send could not be resolved. Retry it with the same ID.");
        return { messageId: replay, mentioned: [] as string[] };
      }
    }
    if (replyToId) {
      const [parent] = await tx.select({ id: message.id }).from(message)
        .where(and(eq(message.id, replyToId), eq(message.channelId, channelId)));
      if (!parent) throw notFound("The message you replied to was deleted.");
    }
    if (threadId) {
      const [root] = await tx.select({ id: message.id }).from(message)
        .where(and(eq(message.id, threadId), eq(message.channelId, channelId), isNull(message.threadId)));
      if (!root) throw notFound("Thread not found.");
    }
    const publication = await checkPublicPost(tx, channelId, publicGeneration, content, ids, replyToId, threadId);
    await validateCommunityAssetRefs(tx, ch.communityId, content);
    await consume(`message:${userId}`, RATE_LIMIT.messages, RATE_LIMIT.windowSeconds * 1000, Date.now(), tx);
    const [created] = await tx.insert(message).values({ channelId, authorId: userId, content, replyToId, threadId }).returning();
    if (publication) await snapshotPublicPost(tx, created);
    await linkAttachments(tx, userId, channelId, created.id, ids);
    const mentioned = await syncMentions(tx, ch.communityId, created.id, userId, content);
    if (transactionId) await tx.update(messageSend).set({ messageId: created.id })
      .where(and(eq(messageSend.userId, userId), eq(messageSend.transactionId, transactionId)));
    await publish({ type: "message.created", communityId: ch.communityId, channelId, messageId: created.id }, tx);
    for (const target of mentioned) await publish({ type: "mention.created", userId: target, communityId: ch.communityId, channelId, messageId: created.id }, tx);
    return { messageId: created.id, mentioned };
  });
  pushMentions(mentioned, channelId, messageId);
  return sentMessage(messageId);
}

/** Most restored sends one tab can ask about at once (matches the browser outbox cap). */
const MAX_STATUS_IDS = 20;

/**
 * Which of the person's own send ids reached the server, for sends restored after a lost response or
 * reload: "sent", or "deleted" when the stored message was removed since. Unknown ids were not stored.
 * Receipts only: no content, and only the caller's own.
 */
export async function sendStatus(userId: string, rawIds: unknown): Promise<Record<string, "sent" | "deleted">> {
  const ids = parse(z.array(uuid).max(MAX_STATUS_IDS), rawIds);
  if (ids.length === 0) return {};
  const rows = await db.select({ id: messageSend.transactionId, messageId: messageSend.messageId }).from(messageSend)
    .where(and(eq(messageSend.userId, userId), inArray(messageSend.transactionId, ids)));
  return Object.fromEntries(rows.map((r) => [r.id, r.messageId ? "sent" : "deleted"]));
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

/** Short-lived "is typing" metadata for a channel. Never persisted; only people who may post can announce it. */
export async function publishChannelTyping(userId: string, rawChannelId: unknown, rawTyping: unknown): Promise<void> {
  const channelId = parse(uuid, rawChannelId);
  const typing = parse(z.boolean(), rawTyping);
  await consume(`channel-typing:${userId}`, 30, 60_000);
  const { channel: ch } = await requireChannel(db, channelId, userId, Permission.SendMessages);
  await publish({ type: "channel.typing", communityId: ch.communityId, channelId, userId, typing, expiresAt: Date.now() + TYPING_TTL_MS });
}

export async function editMessage(userId: string, rawMessageId: unknown, rawContent: unknown, publicGeneration: unknown = null) {
  const content = parse(messageContent, rawContent);
  const row = await loadOwnedMessage(rawMessageId);
  // Muted members (no SendMessages) can't rewrite their history either.
  const { authority } = await requireChannel(db, row.message.channelId, userId, Permission.SendMessages);
  if (row.message.authorId !== userId) throw forbidden("You can only edit your own messages.");
  // The importer owns imported rows, but the words are someone else's.
  if (row.message.importedAuthor) throw forbidden("Imported messages can't be edited.");
  await enforceAutomod(row.communityId, userId, authority, content);
  // Edits update who is mentioned but never notify: otherwise editing a mention out and back in re-pings.
  await db.transaction(async (tx) => {
    await lockCommunity(tx, row.communityId);
    await requireChannel(tx, row.message.channelId, userId, Permission.SendMessages);
    const publication = await checkPublicPost(tx, row.message.channelId, publicGeneration, content);
    await validateCommunityAssetRefs(tx, row.communityId, content);
    await tx.update(message).set({ content, editedAt: new Date() }).where(eq(message.id, row.message.id));
    if (publication) await tx.update(publicPost).set({ content: publicText(content), editedAt: new Date() }).where(eq(publicPost.messageId, row.message.id));
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
    await lockCommunity(tx, row.communityId);
    const current = await requireChannel(tx, row.message.channelId, userId);
    if (!own && !has(current.authority, Permission.ManageMessages)) throw forbidden("You can only delete your own messages.");
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
  await consume(`reaction:${userId}`, 10, 10_000);
  const row = await loadOwnedMessage(rawMessageId);
  await requireChannel(db, row.message.channelId, userId, Permission.SendMessages);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, row.communityId);
    await requireChannel(tx, row.message.channelId, userId, Permission.SendMessages);
    // Serialise per message so the distinct-emoji cap can't be raced.
    await tx.execute(sql`select 1 from ${message} where ${message.id} = ${row.message.id} for update`);
    const removed = await tx.delete(reaction)
      .where(and(eq(reaction.messageId, row.message.id), eq(reaction.userId, userId), eq(reaction.emoji, value)))
      .returning({ emoji: reaction.emoji });
    if (removed.length > 0) return;
    await validateCommunityAssetRefs(tx, row.communityId, value);
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
    await lockCommunity(tx, row.communityId);
    await requireChannel(tx, row.message.channelId, userId, Permission.ManageMessages);
    const [current] = await tx.select({ pinnedAt: message.pinnedAt }).from(message).where(eq(message.id, row.message.id));
    if (!current) throw notFound("Message not found.");
    if (pinned && !current.pinnedAt) {
      // Serialise pins per channel so concurrent pins can't pass the cap.
      await tx.execute(sql`select 1 from ${channel} where ${channel.id} = ${row.message.channelId} for update`);
      const [{ pins }] = await tx.select({ pins: count() }).from(message)
        .where(and(eq(message.channelId, row.message.channelId), isNotNull(message.pinnedAt)));
      if (pins >= MAX_PINS_PER_CHANNEL) throw new AppError("conflict", `A channel can have at most ${MAX_PINS_PER_CHANNEL} pinned messages.`);
    }
    await tx.update(message).set({ pinnedAt: pinned ? (current.pinnedAt ?? new Date()) : null }).where(eq(message.id, row.message.id));
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
