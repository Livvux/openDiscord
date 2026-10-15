import { randomBytes } from "node:crypto";
import { and, asc, count, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, ban, channel, community, invite, member, role } from "@/db/schema";
import { lockCommunity, requireMember } from "./access";
import { AppError, forbidden, notFound } from "./errors";
import { enforceCap } from "./limits";
import { assertActiveUser, assertInvitesAllowed, getInstanceSettings } from "./instance-policy";
import { DEFAULT_MEMBER_PERMISSIONS, Permission, type MemberAuthority } from "./permissions";
import { publish } from "./realtime";
import { channelName, channelTopic, communityName, inviteCode, inviteOptions, parse, uuid } from "./validation";

export interface CommunitySummary {
  id: string;
  name: string;
}

export interface ChannelSummary {
  id: string;
  name: string;
  topic: string | null;
}

export interface CommunityView {
  id: string;
  name: string;
  isOwner: boolean;
  authority: MemberAuthority;
  channels: ChannelSummary[];
}

export async function createCommunity(userId: string, rawName: unknown): Promise<{ communityId: string; channelId: string }> {
  const name = parse(communityName, rawName);
  await assertActiveUser(userId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from "user" where id = ${userId} for update`);
    const CAPS = await getInstanceSettings(tx);
    const [{ owned }] = await tx.select({ owned: count() }).from(community).where(eq(community.ownerId, userId));
    enforceCap(owned, CAPS.ownedCommunities, `You can own at most ${CAPS.ownedCommunities} communities.`);
    const [c] = await tx.insert(community).values({ name, ownerId: userId }).returning({ id: community.id });
    await tx.insert(role).values({ communityId: c.id, name: "everyone", isDefault: true, permissions: DEFAULT_MEMBER_PERMISSIONS });
    await tx.insert(member).values({ communityId: c.id, userId });
    const [ch] = await tx.insert(channel).values({ communityId: c.id, name: "general" }).returning({ id: channel.id });
    return { communityId: c.id, channelId: ch.id };
  });
}

export async function listCommunities(userId: string): Promise<CommunitySummary[]> {
  await assertActiveUser(userId);
  return db
    .select({ id: community.id, name: community.name })
    .from(member)
    .innerJoin(community, eq(community.id, member.communityId))
    .where(and(eq(member.userId, userId), isNull(community.suspendedAt)))
    .orderBy(asc(member.joinedAt));
}

export async function getCommunityView(userId: string, rawId: unknown): Promise<CommunityView> {
  const communityId = parse(uuid, rawId);
  const { community: c, authority } = await requireMember(db, communityId, userId);
  const channels = await db
    .select({ id: channel.id, name: channel.name, topic: channel.topic })
    .from(channel)
    .where(eq(channel.communityId, communityId))
    .orderBy(asc(channel.position), asc(channel.id));
  return { id: c.id, name: c.name, isOwner: authority.isOwner, authority, channels };
}

export async function renameCommunity(userId: string, rawId: unknown, rawName: unknown) {
  const communityId = parse(uuid, rawId);
  const name = parse(communityName, rawName);
  await requireMember(db, communityId, userId, Permission.ManageCommunity);
  await db.update(community).set({ name }).where(eq(community.id, communityId));
  await publish({ type: "channels.changed", communityId });
}

export async function deleteCommunity(userId: string, rawId: unknown) {
  const communityId = parse(uuid, rawId);
  const { authority } = await requireMember(db, communityId, userId);
  if (!authority.isOwner) throw forbidden("Only the owner can delete a community.");
  await db.delete(community).where(eq(community.id, communityId));
  await publish({ type: "community.deleted", communityId });
}

export async function leaveCommunity(userId: string, rawId: unknown) {
  const communityId = parse(uuid, rawId);
  const { authority } = await requireMember(db, communityId, userId);
  if (authority.isOwner) throw forbidden("Owners can't leave. Delete the community instead.");
  await db.delete(member).where(and(eq(member.communityId, communityId), eq(member.userId, userId)));
  await publish({ type: "member.removed", communityId, userId });
}

// --- Channels ---------------------------------------------------------------

export async function createChannel(userId: string, rawCommunityId: unknown, rawName: unknown): Promise<string> {
  const communityId = parse(uuid, rawCommunityId);
  const name = parse(channelName, rawName);
  const ch = await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    await requireMember(tx, communityId, userId, Permission.ManageChannels);
    const CAPS = await getInstanceSettings(tx);
    const [{ total }] = await tx.select({ total: count() }).from(channel).where(eq(channel.communityId, communityId));
    enforceCap(total, CAPS.channelsPerCommunity, `A community can have at most ${CAPS.channelsPerCommunity} channels.`);
    const [created] = await tx.insert(channel).values({
      communityId, name,
      position: sql`(select coalesce(max(${channel.position}), 0) + 1 from ${channel} where ${channel.communityId} = ${communityId})`,
    }).returning({ id: channel.id });
    return created;
  });
  await publish({ type: "channels.changed", communityId });
  return ch.id;
}

export async function updateChannel(userId: string, rawChannelId: unknown, rawName: unknown, rawTopic: unknown) {
  const channelId = parse(uuid, rawChannelId);
  const name = parse(channelName, rawName);
  const topic = parse(channelTopic, rawTopic ?? "");
  const [ch] = await db.select().from(channel).where(eq(channel.id, channelId));
  if (!ch) throw notFound("Channel not found.");
  await requireMember(db, ch.communityId, userId, Permission.ManageChannels);
  await db.update(channel).set({ name, topic: topic || null }).where(eq(channel.id, channelId));
  await publish({ type: "channels.changed", communityId: ch.communityId });
}

export async function deleteChannel(userId: string, rawChannelId: unknown) {
  const channelId = parse(uuid, rawChannelId);
  const [ch] = await db.select().from(channel).where(eq(channel.id, channelId));
  if (!ch) throw notFound("Channel not found.");
  await db.transaction(async (tx) => {
    await requireMember(tx, ch.communityId, userId, Permission.ManageChannels);
    await lockCommunity(tx, ch.communityId);
    const [{ total }] = await tx.select({ total: count() }).from(channel).where(eq(channel.communityId, ch.communityId));
    if (total <= 1) throw forbidden("A community needs at least one channel.");
    await tx.delete(channel).where(eq(channel.id, channelId));
    await tx.insert(auditLog).values({ communityId: ch.communityId, actorId: userId, action: "channel.delete", targetId: ch.name });
  });
  await publish({ type: "channels.changed", communityId: ch.communityId });
}

// --- Invites ----------------------------------------------------------------

export interface InvitePreview {
  code: string;
  communityId: string;
  communityName: string;
  memberCount: number;
}

export async function createInvite(userId: string, rawCommunityId: unknown, rawOptions: unknown): Promise<string> {
  const communityId = parse(uuid, rawCommunityId);
  const options = parse(inviteOptions, rawOptions);
  return db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    await requireMember(tx, communityId, userId, Permission.CreateInvites);
    await assertInvitesAllowed(userId, tx);
    const CAPS = await getInstanceSettings(tx);
    const now = new Date();
    const [{ active }] = await tx
      .select({ active: count() })
      .from(invite)
      .where(
        and(
          eq(invite.communityId, communityId),
          or(isNull(invite.expiresAt), gt(invite.expiresAt, now)),
          or(isNull(invite.maxUses), lt(invite.uses, invite.maxUses)),
        ),
      );
    enforceCap(active, CAPS.activeInvitesPerCommunity, "Too many active invites. Revoke some first.");
    // 96 random bits: invite codes are bearer tokens for joining.
    const code = randomBytes(12).toString("base64url");
    await tx.insert(invite).values({
      code,
      communityId,
      creatorId: userId,
      maxUses: options.maxUses,
      expiresAt: options.expiresInHours ? new Date(Date.now() + options.expiresInHours * 3_600_000) : null,
    });
    return code;
  });
}

function isUsable(row: typeof invite.$inferSelect): boolean {
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return false;
  return row.maxUses === null || row.uses < row.maxUses;
}

export async function getInvitePreview(rawCode: unknown): Promise<InvitePreview> {
  const code = parse(inviteCode, rawCode);
  await assertInvitesAllowed();
  const [row] = await db
    .select({ invite, communityName: community.name })
    .from(invite)
    .innerJoin(community, eq(community.id, invite.communityId))
    .where(and(eq(invite.code, code), isNull(community.suspendedAt)));
  if (!row || !isUsable(row.invite)) throw notFound("This invite is invalid or has expired.");
  const [{ memberCount }] = await db
    .select({ memberCount: count() })
    .from(member)
    .where(eq(member.communityId, row.invite.communityId));
  return { code, communityId: row.invite.communityId, communityName: row.communityName, memberCount };
}

export async function acceptInvite(userId: string, rawCode: unknown): Promise<string> {
  await assertActiveUser(userId);
  await assertInvitesAllowed();
  const code = parse(inviteCode, rawCode);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(invite).where(eq(invite.code, code)).for("update");
    if (!row || !isUsable(row)) throw notFound("This invite is invalid or has expired.");
    const [activeCommunity] = await tx.select({ id: community.id }).from(community)
      .where(and(eq(community.id, row.communityId), isNull(community.suspendedAt)));
    if (!activeCommunity) throw notFound("Community not found.");
    const [banned] = await tx
      .select({ userId: ban.userId })
      .from(ban)
      .where(and(eq(ban.communityId, row.communityId), eq(ban.userId, userId)));
    if (banned) throw new AppError("forbidden", "You are banned from this community.");
    const joined = await tx
      .insert(member)
      .values({ communityId: row.communityId, userId })
      .onConflictDoNothing()
      .returning({ userId: member.userId });
    // Already a member: don't burn a use.
    if (joined.length > 0) {
      await tx.update(invite).set({ uses: sql`${invite.uses} + 1` }).where(eq(invite.code, code));
    }
    return row.communityId;
  });
}

export interface InviteSummary {
  code: string;
  uses: number;
  maxUses: number | null;
  expiresAt: Date | null;
}

export async function listInvites(userId: string, rawCommunityId: unknown): Promise<InviteSummary[]> {
  const communityId = parse(uuid, rawCommunityId);
  await requireMember(db, communityId, userId, Permission.ManageCommunity);
  const rows = await db.select().from(invite).where(eq(invite.communityId, communityId)).orderBy(asc(invite.createdAt));
  return rows.filter(isUsable).map(({ code, uses, maxUses, expiresAt }) => ({ code, uses, maxUses, expiresAt }));
}

export async function revokeInvite(userId: string, rawCode: unknown) {
  const code = parse(inviteCode, rawCode);
  const [row] = await db.select().from(invite).where(eq(invite.code, code));
  if (!row) throw notFound("Invite not found.");
  await requireMember(db, row.communityId, userId, Permission.ManageCommunity);
  await db.delete(invite).where(eq(invite.code, code));
}
