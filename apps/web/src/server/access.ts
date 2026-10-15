// The single place that decides whether a user can see a community, and with which authority.
// Non-members get "not found" rather than "forbidden" so ids don't reveal what exists.
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelOverride, community, member, memberRole, role } from "@/db/schema";
import { assertActiveUser } from "./instance-policy";
import { forbidden, notFound } from "./errors";
import { channelAuthority, has, Permission, resolveAuthority, type MemberAuthority } from "./permissions";

/** A drizzle database or transaction handle. */
export type Db = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute" | "query">;

export interface CommunityAccess {
  community: typeof community.$inferSelect;
  authority: MemberAuthority;
}

/** A member's community-wide authority plus the roles that channel overrides apply to. */
export interface MemberContext {
  authority: MemberAuthority;
  defaultRoleId: string;
  roleIds: string[];
}

export async function loadMember(tx: Db, communityId: string, userId: string): Promise<MemberContext | null> {
  await assertActiveUser(userId, tx);
  const [row] = await tx
    .select({ ownerId: community.ownerId })
    .from(member)
    .innerJoin(community, eq(community.id, member.communityId))
    .where(and(eq(member.communityId, communityId), eq(member.userId, userId), isNull(community.suspendedAt)));
  if (!row) return null;

  const roles = await tx
    .select({ id: role.id, permissions: role.permissions, position: role.position, isDefault: role.isDefault })
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
  return {
    authority: resolveAuthority(row.ownerId === userId, roles),
    defaultRoleId: roles.find((r) => r.isDefault)?.id ?? "",
    roleIds: roles.map((r) => r.id),
  };
}

export async function loadAuthority(tx: Db, communityId: string, userId: string): Promise<MemberAuthority | null> {
  return (await loadMember(tx, communityId, userId))?.authority ?? null;
}

/** Effective permissions in each given channel (all of them must belong to the member's community). */
export async function channelAuthorities(tx: Db, ctx: MemberContext, channelIds: string[]): Promise<Map<string, MemberAuthority>> {
  const overrides = channelIds.length
    ? await tx.select().from(channelOverride).where(inArray(channelOverride.channelId, channelIds))
    : [];
  return new Map(
    channelIds.map((id) => [
      id,
      channelAuthority(ctx.authority, overrides.filter((o) => o.channelId === id), ctx.defaultRoleId, ctx.roleIds),
    ]),
  );
}

/** The member's authority inside one channel, or null when they can't see it. */
export async function loadChannelAuthority(tx: Db, channelId: string, userId: string) {
  const [ch] = await tx.select().from(channel).where(eq(channel.id, channelId));
  const ctx = ch ? await loadMember(tx, ch.communityId, userId) : null;
  if (!ch || !ctx) return null;
  const authority = (await channelAuthorities(tx, ctx, [ch.id])).get(ch.id)!;
  return has(authority, Permission.ViewChannels) ? { channel: ch, authority } : null;
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

/** Hidden channels are "not found", exactly like channels that don't exist. */
export async function requireChannel(tx: Db, channelId: string, userId: string, permission?: number) {
  const access = await loadChannelAuthority(tx, channelId, userId);
  if (!access) throw notFound("Channel not found.");
  if (permission !== undefined && !has(access.authority, permission)) throw forbidden();
  return access;
}

/** Serialises concurrent role/member changes in one community. */
export async function lockCommunity(tx: Db, communityId: string) {
  await tx.execute(sql`select 1 from ${community} where ${community.id} = ${communityId} for update`);
}
