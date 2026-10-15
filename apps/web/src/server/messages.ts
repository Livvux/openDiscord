import { and, count, desc, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, channel, message, user } from "@/db/schema";
import { requireChannel } from "./access";
import { AppError, forbidden, notFound } from "./errors";
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
}

const viewColumns = {
  id: message.id,
  channelId: message.channelId,
  authorId: message.authorId,
  authorName: user.name,
  content: message.content,
  createdAt: message.createdAt,
  editedAt: message.editedAt,
};

function toView(row: { createdAt: Date; editedAt: Date | null } & Omit<MessageView, "createdAt" | "editedAt">): MessageView {
  return { ...row, createdAt: row.createdAt.toISOString(), editedAt: row.editedAt?.toISOString() ?? null };
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
  return { messages: rows.slice(0, PAGE_SIZE).reverse().map(toView), hasMore: rows.length > PAGE_SIZE };
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
  return { communityId, message: toView(view) };
}

export async function sendMessage(userId: string, rawChannelId: unknown, rawContent: unknown): Promise<MessageView> {
  const channelId = parse(uuid, rawChannelId);
  const content = parse(messageContent, rawContent);
  const { channel: ch } = await requireChannel(db, channelId, userId, Permission.SendMessages);

  const since = new Date(Date.now() - RATE_LIMIT.windowSeconds * 1000);
  const [{ recent }] = await db
    .select({ recent: count() })
    .from(message)
    .where(and(eq(message.authorId, userId), gt(message.createdAt, since)));
  if (recent >= RATE_LIMIT.messages) throw new AppError("rate_limited", "You're sending messages too quickly. Wait a moment.");

  const [row] = await db.insert(message).values({ channelId, authorId: userId, content }).returning();
  const [author] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  await publish({ type: "message.created", communityId: ch.communityId, channelId, messageId: row.id });
  return toView({ ...row, authorName: author.name });
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
  await requireChannel(db, row.message.channelId, userId, Permission.SendMessages);
  if (row.message.authorId !== userId) throw forbidden("You can only edit your own messages.");
  await db.update(message).set({ content, editedAt: new Date() }).where(eq(message.id, row.message.id));
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
}
