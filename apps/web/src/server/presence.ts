// Opt-in presence and per-community and per-channel notification levels. Presence is off by default: nobody sees
// whether you're online unless you turn it on. "Online" = an open tab sent a heartbeat recently.
import { and, eq, gt, inArray, lt, or, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { channelNotification, member, userPresence } from "@/db/schema";
import type { PresenceChoice, PresenceStatus } from "@/lib/presence";
import { requireChannel, requireMember } from "./access";
import { parse, uuid } from "./validation";

export const ONLINE_WINDOW_MS = 90_000;
/** Heartbeats closer together than this don't write. */
const TOUCH_INTERVAL_MS = 45_000;

/** Records activity (from the personal event stream's heartbeat), at most one write per interval. */
export async function touchPresence(userId: string, now = new Date()): Promise<void> {
  await db
    .insert(userPresence)
    .values({ userId, lastSeenAt: now })
    .onConflictDoUpdate({
      target: userPresence.userId,
      set: { lastSeenAt: now },
      setWhere: or(isNull(userPresence.lastSeenAt), lt(userPresence.lastSeenAt, new Date(now.getTime() - TOUCH_INTERVAL_MS))),
    });
}

export async function setPresenceVisible(userId: string, visible: unknown): Promise<void> {
  const value = parse(z.boolean(), visible);
  await db.insert(userPresence).values({ userId, visible: value }).onConflictDoUpdate({ target: userPresence.userId, set: { visible: value } });
}

export async function presenceVisible(userId: string): Promise<boolean> {
  const [row] = await db.select({ visible: userPresence.visible }).from(userPresence).where(eq(userPresence.userId, userId));
  return row?.visible ?? false;
}


export async function setPresenceStatus(userId: string, rawChoice: unknown): Promise<void> {
  const choice = parse(z.enum(["online", "idle", "dnd", "invisible"]), rawChoice);
  const set = choice === "invisible" ? { visible: false } : { visible: true, status: choice };
  await db.insert(userPresence).values({ userId, ...set }).onConflictDoUpdate({ target: userPresence.userId, set });
}

export async function presenceChoice(userId: string): Promise<PresenceChoice> {
  const [row] = await db.select({ visible: userPresence.visible, status: userPresence.status }).from(userPresence).where(eq(userPresence.userId, userId));
  return row?.visible ? row.status : "invisible";
}

/** Members of the community who show their presence and were seen recently. */
export async function onlineMembers(userId: string, rawCommunityId: unknown): Promise<{ id: string; status: PresenceStatus }[]> {
  const communityId = parse(uuid, rawCommunityId);
  await requireMember(db, communityId, userId);
  return db
    .select({ id: member.userId, status: userPresence.status })
    .from(member)
    .innerJoin(userPresence, eq(userPresence.userId, member.userId))
    .where(and(eq(member.communityId, communityId), userPresence.visible, gt(userPresence.lastSeenAt, new Date(Date.now() - ONLINE_WINDOW_MS))))
    .limit(1000);
}

// --- Notification level -----------------------------------------------------

export type NotificationLevel = "mentions" | "muted";

export async function setNotificationLevel(userId: string, rawCommunityId: unknown, rawLevel: unknown): Promise<void> {
  const communityId = parse(uuid, rawCommunityId);
  const level = parse(z.enum(["mentions", "muted"]), rawLevel);
  await requireMember(db, communityId, userId);
  await db.update(member).set({ notifications: level }).where(and(eq(member.communityId, communityId), eq(member.userId, userId)));
}

/** "default" removes the channel's own level so the community's applies again. */
export async function setChannelNotificationLevel(userId: string, rawChannelId: unknown, rawLevel: unknown): Promise<void> {
  const channelId = parse(uuid, rawChannelId);
  const level = parse(z.enum(["default", "mentions", "muted"]), rawLevel);
  await requireChannel(db, channelId, userId);
  if (level === "default") {
    await db.delete(channelNotification).where(and(eq(channelNotification.userId, userId), eq(channelNotification.channelId, channelId)));
  } else {
    await db.insert(channelNotification).values({ userId, channelId, level })
      .onConflictDoUpdate({ target: [channelNotification.userId, channelNotification.channelId], set: { level } });
  }
}

/** The person's own level per channel; channels without one are absent. */
export async function channelNotificationLevels(userId: string, channelIds: string[]): Promise<Map<string, NotificationLevel>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db.select({ channelId: channelNotification.channelId, level: channelNotification.level }).from(channelNotification)
    .where(and(eq(channelNotification.userId, userId), inArray(channelNotification.channelId, channelIds)));
  return new Map(rows.map((r) => [r.channelId, r.level]));
}

/** A channel's own level wins over its community's. */
export async function channelMuted(userId: string, channelId: string, communityId: string): Promise<boolean> {
  const own = (await channelNotificationLevels(userId, [channelId])).get(channelId);
  return own ? own === "muted" : (await mutedCommunities(userId, [communityId])).size > 0;
}

export async function mutedCommunities(userId: string, communityIds: string[]): Promise<Set<string>> {
  if (communityIds.length === 0) return new Set();
  const rows = await db
    .select({ communityId: member.communityId })
    .from(member)
    .where(and(eq(member.userId, userId), inArray(member.communityId, communityIds), sql`${member.notifications} = 'muted'`));
  return new Set(rows.map((r) => r.communityId));
}
