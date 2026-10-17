// The profile card behind a clicked name or avatar. Only for accounts you can already see: a shared
// community, a friendship (or request) or a direct conversation. Blocked pairs get the bare name.
import { and, eq, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "@/db";
import { community, dmConversation, friendship, member, user, userBlock, userPresence, userProfile } from "@/db/schema";
import type { PresenceStatus } from "@/lib/presence";
import { notFound } from "./errors";
import type { FriendView } from "./friends";
import { ONLINE_WINDOW_MS } from "./presence";
import { parse } from "./validation";

const MUTUAL_LIMIT = 10;
const accountId = z.string().trim().min(1).max(64);

export interface ProfileCard {
  id: string;
  name: string;
  memberSince: string;
  customStatus: string;
  bio: string;
  presence: PresenceStatus | null;
  relation: FriendView["state"] | null;
  /** You blocked them. */
  blocked: boolean;
  mutualCommunities: { id: string; name: string }[];
}

const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string];

export async function getProfileCard(viewerId: string, rawTarget: unknown): Promise<ProfileCard> {
  const targetId = parse(accountId, rawTarget);
  const [first, second] = pair(viewerId, targetId);
  const shared = alias(member, "profile_shared");
  const [[person], mutual, [friend], [conversation], blocks] = await Promise.all([
    db
      .select({ name: user.name, createdAt: user.createdAt, bio: userProfile.bio, customStatus: userProfile.customStatus, visible: userPresence.visible, status: userPresence.status, lastSeenAt: userPresence.lastSeenAt })
      .from(user)
      .leftJoin(userProfile, eq(userProfile.userId, user.id))
      .leftJoin(userPresence, eq(userPresence.userId, user.id))
      .where(eq(user.id, targetId)),
    db
      .select({ id: community.id, name: community.name })
      .from(member)
      .innerJoin(shared, and(eq(shared.communityId, member.communityId), eq(shared.userId, viewerId)))
      .innerJoin(community, eq(community.id, member.communityId))
      .where(eq(member.userId, targetId))
      .orderBy(community.name)
      .limit(MUTUAL_LIMIT),
    db.select({ status: friendship.status, requestedBy: friendship.requestedBy }).from(friendship).where(and(eq(friendship.firstId, first), eq(friendship.secondId, second))),
    db.select({ id: dmConversation.id }).from(dmConversation).where(and(eq(dmConversation.firstId, first), eq(dmConversation.secondId, second), ne(dmConversation.status, "rejected"))).limit(1),
    db
      .select({ blockerId: userBlock.blockerId })
      .from(userBlock)
      .where(or(and(eq(userBlock.blockerId, viewerId), eq(userBlock.blockedId, targetId)), and(eq(userBlock.blockerId, targetId), eq(userBlock.blockedId, viewerId)))),
  ]);
  const self = viewerId === targetId;
  if (!person || (!self && !mutual.length && !friend && !conversation)) throw notFound("Profile not found.");
  const relation: ProfileCard["relation"] = !friend ? null : friend.status === "accepted" ? "friend" : friend.requestedBy === viewerId ? "outgoing" : "incoming";
  const blocked = blocks.some((b) => b.blockerId === viewerId);
  const base = { id: targetId, name: person.name, memberSince: person.createdAt.toISOString(), relation, blocked };
  if (blocks.length) return { ...base, relation: null, customStatus: "", bio: "", presence: null, mutualCommunities: [] };
  const online = person.visible && person.lastSeenAt && person.lastSeenAt > new Date(Date.now() - ONLINE_WINDOW_MS);
  return {
    ...base,
    customStatus: person.customStatus ?? "",
    bio: person.bio ?? "",
    presence: online ? (person.status ?? "online") : null,
    mutualCommunities: self ? [] : mutual,
  };
}

