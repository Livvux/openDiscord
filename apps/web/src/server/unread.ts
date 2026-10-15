// Unread state: one "last read" message id per person and channel. A channel is unread when someone
// else posted after it; mentions are counted the same way. Counts only cover channels the caller passes
// in, and callers pass only channels the person can view.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelReadState, mention, message } from "@/db/schema";
import { channelAuthorities, loadMember, requireChannel } from "./access";
import { Permission } from "./permissions";
import { notFound } from "./errors";
import { parse, uuid } from "./validation";

export interface UnreadState {
  unread: boolean;
  mentions: number;
}

export interface ChannelUnread extends UnreadState {
  /** Where the "new messages" divider goes; null when the channel was never opened. */
  lastReadId: string | null;
}

/** Badges show "99+" anyway; capping keeps each count query bounded. */
export const MENTION_COUNT_CAP = 100;

export const NOTHING_UNREAD: ChannelUnread = { unread: false, mentions: 0, lastReadId: null };

/** Moves the read marker forward (never back) to `messageId`. */
export async function markChannelRead(userId: string, rawChannelId: unknown, rawMessageId: unknown): Promise<void> {
  const channelId = parse(uuid, rawChannelId);
  const messageId = parse(uuid, rawMessageId);
  await requireChannel(db, channelId, userId);
  // Only real messages of this channel: a forged far-future id would hide unread state forever.
  const [known] = await db.select({ id: message.id }).from(message).where(and(eq(message.id, messageId), eq(message.channelId, channelId)));
  if (!known) throw notFound("Message not found.");
  // UUIDv7 ids sort by time, so the newer marker is the greater id.
  await db
    .insert(channelReadState)
    .values({ userId, channelId, lastReadId: messageId })
    .onConflictDoUpdate({
      target: [channelReadState.userId, channelReadState.channelId],
      set: { lastReadId: sql`greatest(${channelReadState.lastReadId}, excluded.last_read_id)` },
    });
}

export async function unreadState(userId: string, channelIds: string[]): Promise<Map<string, ChannelUnread>> {
  if (channelIds.length === 0) return new Map();
  const after = (m: typeof message) => sql`(${channelReadState.lastReadId} is null or ${m.id} > ${channelReadState.lastReadId})`;
  const rows = await db
    .select({
      channelId: channel.id,
      lastReadId: channelReadState.lastReadId,
      unread: sql<boolean>`exists (select 1 from ${message} where ${message.channelId} = ${channel.id} and ${message.authorId} <> ${userId} and ${after(message)})`,
      // shortcut: one correlated query per channel; switch to a grouped query if communities grow to hundreds of channels.
      mentions: sql<number>`(select count(*) from (select 1 from ${mention} inner join ${message} on ${message.id} = ${mention.messageId} where ${mention.userId} = ${userId} and ${message.channelId} = ${channel.id} and ${after(message)} limit ${MENTION_COUNT_CAP}) capped)`.mapWith(Number),
    })
    .from(channel)
    .leftJoin(channelReadState, and(eq(channelReadState.channelId, channel.id), eq(channelReadState.userId, userId)))
    .where(inArray(channel.id, channelIds));
  return new Map(rows.map(({ channelId, ...state }) => [channelId, state]));
}

/**
 * Unread state per community, over the channels the person can view.
 * shortcut: two queries per community for visibility; batch them if people join hundreds of communities.
 */
export async function communityUnread(userId: string, communities: readonly { id: string }[]): Promise<Map<string, UnreadState>> {
  if (communities.length === 0) return new Map();
  const channels = await db
    .select({ id: channel.id, communityId: channel.communityId })
    .from(channel)
    .where(inArray(channel.communityId, communities.map((c) => c.id)));
  const visible: { id: string; communityId: string }[] = [];
  for (const c of communities) {
    const ctx = await loadMember(db, c.id, userId);
    if (!ctx) continue;
    const own = channels.filter((ch) => ch.communityId === c.id);
    const perms = await channelAuthorities(db, ctx, own.map((ch) => ch.id));
    visible.push(...own.filter((ch) => (perms.get(ch.id)!.permissions & Permission.ViewChannels) !== 0));
  }
  const states = await unreadState(userId, visible.map((ch) => ch.id));
  const result = new Map<string, UnreadState>();
  for (const ch of visible) {
    const state = states.get(ch.id) ?? NOTHING_UNREAD;
    const sum = result.get(ch.communityId) ?? NOTHING_UNREAD;
    result.set(ch.communityId, { unread: sum.unread || state.unread, mentions: sum.mentions + state.mentions });
  }
  return result;
}
