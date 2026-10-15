// The single place that decides whether a user can see a community, and with which authority.
// Non-members get "not found" rather than "forbidden" so ids don't reveal what exists.
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { channel, community, member, memberRole, role } from "@/db/schema";
import { forbidden, notFound } from "./errors";
import { has, resolveAuthority, type MemberAuthority } from "./permissions";

/** A drizzle database or transaction handle. */
export type Db = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute" | "query">;

export interface CommunityAccess {
  community: typeof community.$inferSelect;
  authority: MemberAuthority;
}

export async function loadAuthority(tx: Db, communityId: string, userId: string): Promise<MemberAuthority | null> {
  const [row] = await tx
    .select({ ownerId: community.ownerId })
    .from(member)
    .innerJoin(community, eq(community.id, member.communityId))
    .where(and(eq(member.communityId, communityId), eq(member.userId, userId)));
  if (!row) return null;

  const roles = await tx
    .select({ permissions: role.permissions, position: role.position })
    .from(role)
    .where(
      and(
        eq(role.communityId, communityId),
        or(
          role.isDefault,
          inArray(
            role.id,
            tx
              .select({ id: memberRole.roleId })
              .from(memberRole)
              .where(and(eq(memberRole.communityId, communityId), eq(memberRole.userId, userId))),
          ),
        ),
      ),
    );
  return resolveAuthority(row.ownerId === userId, roles);
}

export async function requireMember(
  tx: Db,
  communityId: string,
  userId: string,
  permission?: number,
): Promise<CommunityAccess> {
  const [row] = await tx.select().from(community).where(eq(community.id, communityId));
  const authority = row ? await loadAuthority(tx, communityId, userId) : null;
  if (!row || !authority) throw notFound("Community not found.");
  if (permission !== undefined && !has(authority, permission)) throw forbidden();
  return { community: row, authority };
}

export async function requireChannel(tx: Db, channelId: string, userId: string, permission?: number) {
  const [ch] = await tx.select().from(channel).where(eq(channel.id, channelId));
  const authority = ch ? await loadAuthority(tx, ch.communityId, userId) : null;
  if (!ch || !authority) throw notFound("Channel not found.");
  if (permission !== undefined && !has(authority, permission)) throw forbidden();
  return { channel: ch, authority };
}

/** Serialises concurrent role/member changes in one community. */
export async function lockCommunity(tx: Db, communityId: string) {
  await tx.execute(sql`select 1 from ${community} where ${community.id} = ${communityId} for update`);
}
