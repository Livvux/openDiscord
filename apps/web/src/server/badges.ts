// Profile badges. Most are derived from what an account is or did; only granted ones live in `user_badge`.
import { count, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { community, instanceAdmin, user, userBadge } from "@/db/schema";
import { BADGES, EARLY_SUPPORTER_LIMIT, type BadgeId } from "@/lib/badges";

/** Badges in display order. */
export async function badgesOf(userId: string): Promise<BadgeId[]> {
  const [[admin], granted, [founder], [person]] = await Promise.all([
    db.select({ userId: instanceAdmin.userId }).from(instanceAdmin).where(eq(instanceAdmin.userId, userId)),
    db.select({ badge: userBadge.badge }).from(userBadge).where(eq(userBadge.userId, userId)),
    db.select({ id: community.id }).from(community).where(eq(community.ownerId, userId)).limit(1),
    db.select({ createdAt: user.createdAt }).from(user).where(eq(user.id, userId)),
  ]);
  const [earlier] = person
    ? await db.select({ n: count() }).from(user).where(lt(user.createdAt, person.createdAt))
    : [];
  const has: Record<BadgeId, boolean> = {
    system_admin: !!admin,
    hypesquad: granted.some((g) => g.badge === "hypesquad"),
    early_supporter: !!earlier && earlier.n < EARLY_SUPPORTER_LIMIT,
    community_founder: !!founder,
  };
  return BADGES.map((b) => b.id).filter((id) => has[id]);
}
