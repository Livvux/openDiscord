// Friends: a mutual opt-in between two accounts. There is still no global directory: you find people
// through communities you share, or by a friend code (the account id) they chose to give you.
// Blocked pairs look like unknown accounts, and blocking removes the friendship.
import { and, asc, eq, gt, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "@/db";
import { dmConversation, friendship, member, user, userBlock, userPresence, userProfile } from "@/db/schema";
import { avatarOf } from "./avatars";
import { AppError, invalid, notFound } from "./errors";
import { consume, enforceCap } from "./limits";
import { AccountBlocked, assertActiveUser } from "./instance-policy";
import type { PresenceStatus } from "@/lib/presence";
import { ONLINE_WINDOW_MS } from "./presence";
import { publish } from "./realtime";
import { parse } from "./validation";

export const MAX_FRIENDS = 1000;
export const MAX_OUTGOING_REQUESTS = 100;
export const MAX_INCOMING_REQUESTS = 100;
const accountId = z.string().trim().min(1, "Enter a friend code.").max(64, "That friend code is not valid.");
const searchQuery = z.string().trim().min(2, "Type at least 2 characters.").max(64);
const UNKNOWN = "No account found for that friend code.";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string];
const pairWhere = (a: string, b: string) => {
  const [first, second] = pair(a, b);
  return and(eq(friendship.firstId, first), eq(friendship.secondId, second));
};
const involves = (id: string) => or(eq(friendship.firstId, id), eq(friendship.secondId, id));

export interface FriendView {
  id: string;
  name: string;
  avatar: string | null;
  /** accepted, or a pending request in either direction. */
  state: "friend" | "incoming" | "outgoing";
  /** Present only for friends who show their presence and are online. */
  presence: PresenceStatus | null;
  customStatus: string;
  bio: string;
  since: string;
}

export interface PersonResult {
  id: string;
  name: string;
  avatar: string | null;
  relation: FriendView["state"] | null;
}

async function blockedEitherWay(tx: Tx | Db, a: string, b: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: userBlock.blockerId })
    .from(userBlock)
    .where(or(and(eq(userBlock.blockerId, a), eq(userBlock.blockedId, b)), and(eq(userBlock.blockerId, b), eq(userBlock.blockedId, a))))
    .limit(1);
  return !!row;
}

export async function areFriends(tx: Tx | Db, a: string, b: string): Promise<boolean> {
  const [row] = await tx.select({ status: friendship.status }).from(friendship).where(pairWhere(a, b));
  return row?.status === "accepted";
}

/** Sends a request; if the other person already asked, this accepts theirs instead. */
export async function sendFriendRequest(actorId: string, rawTarget: unknown): Promise<"sent" | "accepted" | "already"> {
  const targetId = parse(accountId, rawTarget);
  if (targetId === actorId) throw invalid("That's your own friend code.");
  await consume(`friend-request:${actorId}`, 20, 3_600_000);
  const result = await db.transaction(async (tx): Promise<"sent" | "accepted" | "already"> => {
    // Actor first (caps), then the pair (crossing requests); the pair lock is always taken last, so no cycles.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actorId}, 33))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${pair(actorId, targetId).join(":")}, 32))`);
    const [target] = await tx.select({ id: user.id }).from(user).where(eq(user.id, targetId));
    if (!target || (await blockedEitherWay(tx, actorId, targetId))) throw notFound(UNKNOWN);
    try {
      await assertActiveUser(targetId, tx);
    } catch (error) {
      if (error instanceof AccountBlocked) throw notFound(UNKNOWN);
      throw error;
    }
    const [existing] = await tx.select().from(friendship).where(pairWhere(actorId, targetId));
    if (existing?.status === "accepted") return "already";
    if (existing && existing.requestedBy === actorId) return "already";
    if (existing) {
      await tx.update(friendship).set({ status: "accepted" }).where(pairWhere(actorId, targetId));
      await acceptPendingConversation(tx, actorId, targetId);
      return "accepted";
    }
    // Re-asking after a decline is throttled per pair, and nobody's inbox can be flooded.
    await consume(`friend-request-pair:${pair(actorId, targetId).join(":")}`, 3, 7 * 86_400_000);
    const incoming = await tx.$count(friendship, and(involves(targetId), ne(friendship.requestedBy, targetId), eq(friendship.status, "pending")));
    enforceCap(incoming, MAX_INCOMING_REQUESTS, "This person can't receive more friend requests right now.");
    const outgoing = await tx.$count(friendship, and(eq(friendship.requestedBy, actorId), eq(friendship.status, "pending")));
    enforceCap(outgoing, MAX_OUTGOING_REQUESTS, `You have ${MAX_OUTGOING_REQUESTS} pending requests. Cancel some before sending more.`);
    const total = await tx.$count(friendship, involves(actorId));
    enforceCap(total, MAX_FRIENDS, `You can have at most ${MAX_FRIENDS} friends and requests.`);
    const [first, second] = pair(actorId, targetId);
    await tx.insert(friendship).values({ firstId: first, secondId: second, requestedBy: actorId });
    return "sent";
  });
  if (result !== "already") await announceFriends([targetId, actorId]);
  return result;
}

/** Live refresh of Home and the friends list for both sides; ids only, best effort. */
async function announceFriends(userIds: string[]): Promise<void> {
  try {
    for (const userId of userIds) await publish({ type: "friends.changed", userId });
  } catch (error) {
    console.error("[realtime] friends event failed", error);
  }
}

export async function respondToFriendRequest(actorId: string, rawOther: unknown, rawAccept: unknown): Promise<void> {
  const otherId = parse(accountId, rawOther);
  const accept = parse(z.boolean(), rawAccept);
  const where = and(pairWhere(actorId, otherId), eq(friendship.requestedBy, otherId), eq(friendship.status, "pending"));
  await db.transaction(async (tx) => {
    const changed = accept
      ? await tx.update(friendship).set({ status: "accepted" }).where(where).returning({ id: friendship.firstId })
      : await tx.delete(friendship).where(where).returning({ id: friendship.firstId });
    if (!changed.length) throw new AppError("conflict", "This request is no longer pending.");
    if (accept) await acceptPendingConversation(tx, actorId, otherId);
  });
  // A decline stays quiet for the sender, like removeFriend.
  await announceFriends(accept ? [otherId, actorId] : [actorId]);
}

/** A message request (even a declined one) between two people who just became friends needs no separate answer. */
async function acceptPendingConversation(tx: Tx, a: string, b: string): Promise<void> {
  const [first, second] = pair(a, b);
  await tx
    .update(dmConversation)
    .set({ status: "accepted" })
    .where(and(eq(dmConversation.firstId, first), eq(dmConversation.secondId, second), ne(dmConversation.status, "accepted")));
}

/** Cancels your own pending request, declines theirs, or ends a friendship. Always quiet for the other side. */
export async function removeFriend(actorId: string, rawOther: unknown): Promise<void> {
  const otherId = parse(accountId, rawOther);
  await db.delete(friendship).where(pairWhere(actorId, otherId));
  await announceFriends([actorId]);
}

export async function listFriends(actorId: string): Promise<FriendView[]> {
  const rows = await db.select().from(friendship).where(involves(actorId)).orderBy(asc(friendship.createdAt)).limit(MAX_FRIENDS);
  if (!rows.length) return [];
  const peerOf = (r: (typeof rows)[number]) => (r.firstId === actorId ? r.secondId : r.firstId);
  const ids = rows.map(peerOf);
  const [people, presence, blocked] = await Promise.all([
    db
      .select({ id: user.id, name: user.name, avatar: avatarOf(user.id), customStatus: userProfile.customStatus, bio: userProfile.bio })
      .from(user)
      .leftJoin(userProfile, eq(userProfile.userId, user.id))
      .where(inArray(user.id, ids)),
    db
      .select({ id: userPresence.userId, status: userPresence.status })
      .from(userPresence)
      .where(and(inArray(userPresence.userId, ids), userPresence.visible, gt(userPresence.lastSeenAt, new Date(Date.now() - ONLINE_WINDOW_MS)))),
    db.select({ id: userBlock.blockedId }).from(userBlock).where(and(eq(userBlock.blockerId, actorId), inArray(userBlock.blockedId, ids))),
  ]);
  const byId = new Map(people.map((p) => [p.id, p]));
  const online = new Map(presence.map((p) => [p.id, p.status]));
  const hidden = new Set(blocked.map((b) => b.id));
  return rows
    .filter((r) => !hidden.has(peerOf(r)) && byId.has(peerOf(r)))
    .map((r) => {
      const id = peerOf(r);
      const person = byId.get(id)!;
      const friend = r.status === "accepted";
      return {
        id,
        name: person.name,
        avatar: person.avatar,
        state: friend ? "friend" : r.requestedBy === actorId ? "outgoing" : "incoming",
        presence: friend ? (online.get(id) ?? null) : null,
        customStatus: friend ? (person.customStatus ?? "") : "",
        bio: friend ? (person.bio ?? "") : "",
        since: r.createdAt.toISOString(),
      } satisfies FriendView;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Members of communities you share whose display name matches. No results for blocked pairs. */
export async function searchPeople(actorId: string, rawQuery: unknown): Promise<PersonResult[]> {
  const query = parse(searchQuery, rawQuery);
  await consume(`people-search:${actorId}`, 30, 60_000);
  const shared = alias(member, "shared");
  const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .selectDistinct({ id: user.id, name: user.name, avatar: avatarOf(user.id) })
    .from(member)
    .innerJoin(shared, and(eq(shared.communityId, member.communityId), eq(shared.userId, actorId)))
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        ne(member.userId, actorId),
        ilike(user.name, pattern),
        sql`not exists (select 1 from user_suspension where user_id = ${user.id})`,
        ne(user.approvalStatus, "rejected"),
        sql`not exists (select 1 from ${userBlock} where (${userBlock.blockerId} = ${actorId} and ${userBlock.blockedId} = ${user.id}) or (${userBlock.blockerId} = ${user.id} and ${userBlock.blockedId} = ${actorId}))`,
      ),
    )
    .orderBy(asc(user.name))
    .limit(20);
  if (!rows.length) return [];
  const relations = await db
    .select()
    .from(friendship)
    .where(and(involves(actorId), or(inArray(friendship.firstId, rows.map((r) => r.id)), inArray(friendship.secondId, rows.map((r) => r.id)))));
  return rows.map((r) => {
    const rel = relations.find((f) => f.firstId === r.id || f.secondId === r.id);
    return { ...r, relation: !rel ? null : rel.status === "accepted" ? "friend" : rel.requestedBy === actorId ? "outgoing" : "incoming" };
  });
}
