import { randomBytes } from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, ban, channel, channelOverride, community, integration, invite, member, role, user } from "@/db/schema";
import { channelAuthorities, loadMember, lockCommunity, requireChannel, requireMember, type Db } from "./access";
import { AppError, forbidden, invalid, notFound } from "./errors";
import { enforceCap } from "./limits";
import { assertActiveUser, assertInvitesAllowed, getInstanceSettings } from "./instance-policy";
import { canManageRole, CHANNEL_PERMISSIONS, DEFAULT_MEMBER_PERMISSIONS, has, Permission, type MemberAuthority } from "./permissions";
import { publish } from "./realtime";
import { listCategories, type CategorySummary } from "./categories";
import { afterAccessChange, closeVoiceRoom, voiceEnabled } from "./voice";
import { NOTHING_UNREAD, unreadState } from "./unread";
import { z } from "zod";
import { channelName, channelTopic, communityName, inviteCode, inviteOptions, parse, uuid } from "./validation";

export interface CommunitySummary {
  id: string;
  name: string;
}

export interface ChannelSummary {
  id: string;
  name: string;
  topic: string | null;
  kind: "text" | "voice";
  categoryId: string | null;
  /** The viewer's effective permissions in this channel. */
  permissions: number;
  /** Hidden from the default role. */
  isPrivate: boolean;
  unread: boolean;
  mentions: number;
  lastReadId: string | null;
}

export interface CommunityView {
  id: string;
  name: string;
  isOwner: boolean;
  /** The viewer's notification level here. */
  notifications: "mentions" | "muted";
  categories: CategorySummary[];
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
  const [c] = await db.select().from(community).where(eq(community.id, communityId));
  const ctx = c ? await loadMember(db, communityId, userId) : null;
  if (!c || !ctx) throw notFound("Community not found.");
  const rows = await db
    .select({ id: channel.id, name: channel.name, topic: channel.topic, kind: channel.kind, categoryId: channel.categoryId })
    .from(channel)
    .where(eq(channel.communityId, communityId))
    .orderBy(asc(channel.position), asc(channel.id));
  const perms = await channelAuthorities(db, ctx, rows.map((r) => r.id));
  const hidden = await db
    .select({ channelId: channelOverride.channelId })
    .from(channelOverride)
    .where(and(eq(channelOverride.roleId, ctx.defaultRoleId), sql`${channelOverride.deny} & ${Permission.ViewChannels} <> 0`));
  const visible = rows
    .map((r) => ({ ...r, permissions: perms.get(r.id)!.permissions, isPrivate: hidden.some((h) => h.channelId === r.id) }))
    .filter((r) => (r.permissions & Permission.ViewChannels) !== 0);
  const unread = await unreadState(userId, visible.map((r) => r.id));
  const channels = visible.map((r) => ({ ...r, ...(unread.get(r.id) ?? NOTHING_UNREAD) }));
  const [own] = await db.select({ notifications: member.notifications }).from(member)
    .where(and(eq(member.communityId, communityId), eq(member.userId, userId)));
  return {
    id: c.id, name: c.name, isOwner: ctx.authority.isOwner, notifications: own?.notifications ?? "mentions",
    // Group names can be sensitive too: members only get groups with a channel they can see.
    categories: (await listCategories(communityId)).filter(
      (cat) => has(ctx.authority, Permission.ManageChannels) || channels.some((ch) => ch.categoryId === cat.id),
    ),
    authority: ctx.authority, channels,
  };
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
  const voiceRooms = await db.select({ id: channel.id }).from(channel).where(and(eq(channel.communityId, communityId), eq(channel.kind, "voice")));
  // Bot and webhook accounts exist only for this community; their messages go with it anyway.
  const botUsers = await db.select({ id: integration.userId }).from(integration).where(eq(integration.communityId, communityId));
  await db.transaction(async (tx) => {
    await tx.delete(community).where(eq(community.id, communityId));
    if (botUsers.length) await tx.delete(user).where(inArray(user.id, botUsers.map((b) => b.id)));
  });
  await publish({ type: "community.deleted", communityId });
  await Promise.all(voiceRooms.map((r) => closeVoiceRoom(r.id)));
}

export async function leaveCommunity(userId: string, rawId: unknown) {
  const communityId = parse(uuid, rawId);
  const { authority } = await requireMember(db, communityId, userId);
  if (authority.isOwner) throw forbidden("Owners can't leave. Delete the community instead.");
  await db.delete(member).where(and(eq(member.communityId, communityId), eq(member.userId, userId)));
  await publish({ type: "member.removed", communityId, userId });
  afterAccessChange(communityId);
}

// --- Channels ---------------------------------------------------------------

export async function createChannel(userId: string, rawCommunityId: unknown, rawName: unknown, rawKind: unknown = "text"): Promise<string> {
  const communityId = parse(uuid, rawCommunityId);
  const name = parse(channelName, rawName);
  const kind = parse(z.enum(["text", "voice"]), rawKind);
  if (kind === "voice" && !voiceEnabled) throw invalid("Voice isn't set up on this instance.");
  const ch = await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    await requireMember(tx, communityId, userId, Permission.ManageChannels);
    const CAPS = await getInstanceSettings(tx);
    const [{ total }] = await tx.select({ total: count() }).from(channel).where(eq(channel.communityId, communityId));
    enforceCap(total, CAPS.channelsPerCommunity, `A community can have at most ${CAPS.channelsPerCommunity} channels.`);
    const [created] = await tx.insert(channel).values({
      communityId, name, kind,
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
  const { channel: ch } = await requireChannel(db, channelId, userId, Permission.ManageChannels);
  await db.update(channel).set({ name, topic: topic || null }).where(eq(channel.id, channelId));
  await publish({ type: "channels.changed", communityId: ch.communityId });
}

export async function deleteChannel(userId: string, rawChannelId: unknown) {
  const channelId = parse(uuid, rawChannelId);
  const { channel: ch } = await requireChannel(db, channelId, userId, Permission.ManageChannels);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, ch.communityId);
    await requireChannel(tx, channelId, userId, Permission.ManageChannels);
    const [{ total }] = await tx.select({ total: count() }).from(channel).where(eq(channel.communityId, ch.communityId));
    if (total <= 1) throw forbidden("A community needs at least one channel.");
    const targetId = await auditChannelName(tx, ch);
    await tx.delete(channel).where(eq(channel.id, channelId));
    await tx.insert(auditLog).values({ communityId: ch.communityId, actorId: userId, action: "channel.delete", targetId });
  });
  await publish({ type: "channels.changed", communityId: ch.communityId });
  if (ch.kind === "voice") await closeVoiceRoom(ch.id);
}

// --- Channel permission overrides -------------------------------------------

export interface ChannelOverrideView {
  roleId: string;
  roleName: string;
  position: number;
  isDefault: boolean;
  allow: number;
  deny: number;
}

/** Every role of the channel's community with its override (0/0 when none). */
export async function listChannelOverrides(userId: string, rawChannelId: unknown): Promise<ChannelOverrideView[]> {
  const channelId = parse(uuid, rawChannelId);
  const { channel: ch } = await requireChannelManager(db, channelId, userId);
  const rows = await db
    .select({ roleId: role.id, roleName: role.name, position: role.position, isDefault: role.isDefault, allow: channelOverride.allow, deny: channelOverride.deny })
    .from(role)
    .leftJoin(channelOverride, and(eq(channelOverride.roleId, role.id), eq(channelOverride.channelId, channelId)))
    .where(eq(role.communityId, ch.communityId))
    .orderBy(asc(role.position), asc(role.id));
  return rows.map((r) => ({ ...r, allow: r.allow ?? 0, deny: r.deny ?? 0 }));
}

/**
 * Overrides need both channel and role management (they change who sees what), and the channel must be
 * visible to the actor: a manager excluded from a channel can't let themselves in.
 */
async function requireChannelManager(tx: Db, channelId: string, userId: string) {
  return requireChannel(tx, channelId, userId, Permission.ManageChannels | Permission.ManageRoles);
}

/** The audit log is readable by people who may not see private channels, so their names stay out of it. */
async function auditChannelName(tx: Db, ch: typeof channel.$inferSelect): Promise<string | null> {
  const [hidden] = await tx
    .select({ channelId: channelOverride.channelId })
    .from(channelOverride)
    .innerJoin(role, eq(role.id, channelOverride.roleId))
    .where(and(eq(channelOverride.channelId, ch.id), role.isDefault, sql`${channelOverride.deny} & ${Permission.ViewChannels} <> 0`));
  return hidden ? null : ch.name;
}

const overrideBits = z.number().int().min(0).max(CHANNEL_PERMISSIONS).refine((n) => (n & ~CHANNEL_PERMISSIONS) === 0, "Unknown permission.");

export async function setChannelOverride(userId: string, rawChannelId: unknown, rawRoleId: unknown, rawAllow: unknown, rawDeny: unknown) {
  const channelId = parse(uuid, rawChannelId);
  const roleId = parse(uuid, rawRoleId);
  const allow = parse(overrideBits, rawAllow);
  const deny = parse(overrideBits, rawDeny);
  if (allow & deny) throw invalid("A permission can't be both allowed and denied.");
  const communityId = await db.transaction(async (tx) => {
    // A channel's community never changes, so locking after the first read is safe; authority is re-read under the lock.
    const [ref] = await tx.select({ communityId: channel.communityId }).from(channel).where(eq(channel.id, channelId));
    if (ref) await lockCommunity(tx, ref.communityId);
    const { channel: ch, authority } = await requireChannelManager(tx, channelId, userId);
    const [r] = await tx.select().from(role).where(and(eq(role.id, roleId), eq(role.communityId, ch.communityId)));
    if (!r) throw notFound("Role not found.");
    // Same escalation rule as editing the role itself: only roles below you, only bits you hold in this channel.
    if (!canManageRole(authority, r.position, allow | deny) || !has(authority, allow | deny)) throw forbidden();
    if (allow === 0 && deny === 0) {
      await tx.delete(channelOverride).where(and(eq(channelOverride.channelId, channelId), eq(channelOverride.roleId, roleId)));
    } else {
      await tx.insert(channelOverride).values({ channelId, roleId, allow, deny })
        .onConflictDoUpdate({ target: [channelOverride.channelId, channelOverride.roleId], set: { allow, deny } });
    }
    const targetId = await auditChannelName(tx, ch);
    await tx.insert(auditLog).values({ communityId: ch.communityId, actorId: userId, action: "channel.permissions", targetId, reason: r.name });
    return ch.communityId;
  });
  await publish({ type: "channels.changed", communityId });
  afterAccessChange(communityId);
}

// --- Invites ----------------------------------------------------------------

export interface InvitePreview {
  code: string;
  communityId: string;
  communityName: string;
  memberCount: number;
  paused: boolean;
  rules: string;
  rulesVersion: number;
  rulesRequired: boolean;
}

export async function createInvite(userId: string, rawCommunityId: unknown, rawOptions: unknown): Promise<string> {
  const communityId = parse(uuid, rawCommunityId);
  const options = parse(inviteOptions, rawOptions);
  return db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    const { community: c } = await requireMember(tx, communityId, userId, Permission.CreateInvites);
    await assertInvitesAllowed(userId, tx);
    if (c.invitesPausedAt) throw forbidden("Invites to this community are paused.");
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
    .select({ invite, communityName: community.name, pausedAt: community.invitesPausedAt, rules: community.rules, rulesVersion: community.rulesVersion, rulesRequired: community.rulesRequired })
    .from(invite)
    .innerJoin(community, eq(community.id, invite.communityId))
    .where(and(eq(invite.code, code), isNull(community.suspendedAt)));
  if (!row || !isUsable(row.invite)) throw notFound("This invite is invalid or has expired.");
  const [{ memberCount }] = await db
    .select({ memberCount: count() })
    .from(member)
    .where(eq(member.communityId, row.invite.communityId));
  return { code, communityId: row.invite.communityId, communityName: row.communityName, memberCount, paused: row.pausedAt !== null, rules: row.rules, rulesVersion: row.rulesVersion, rulesRequired: row.rulesRequired };
}

// Pauses only end when a moderator resumes invites, so "try again later" would mislead.
const PAUSED_MESSAGE = "Invites to this community are paused. Ask a moderator of the community.";

/** Raid protection counts joins in this window. */
export const RAID_WINDOW_MINUTES = 10;

export async function acceptInvite(userId: string, rawCode: unknown, acceptedRulesVersion?: unknown): Promise<string> {
  await assertActiveUser(userId);
  await assertInvitesAllowed();
  const code = parse(inviteCode, rawCode);
  const result = await db.transaction(async (tx) => {
    const [ref] = await tx.select({ communityId: invite.communityId }).from(invite).where(eq(invite.code, code));
    if (!ref) throw notFound("This invite is invalid or has expired.");
    // Serialises joins per community, so the raid counter can't be outrun by concurrent joins.
    await lockCommunity(tx, ref.communityId);
    const [row] = await tx.select().from(invite).where(eq(invite.code, code)).for("update");
    if (!row || !isUsable(row)) throw notFound("This invite is invalid or has expired.");
    const [c] = await tx.select().from(community).where(and(eq(community.id, row.communityId), isNull(community.suspendedAt)));
    if (!c) throw notFound("Community not found.");
    const [banned] = await tx
      .select({ userId: ban.userId })
      .from(ban)
      .where(and(eq(ban.communityId, row.communityId), eq(ban.userId, userId)));
    if (banned) throw new AppError("forbidden", "You are banned from this community.");
    const [existing] = await tx.select({ userId: member.userId }).from(member)
      .where(and(eq(member.communityId, row.communityId), eq(member.userId, userId)));
    // Already a member: nothing to check and don't burn a use.
    if (existing) return { communityId: row.communityId };
    if (c.rulesRequired && acceptedRulesVersion !== c.rulesVersion) throw forbidden("Read and acknowledge the current community rules before joining.");
    if (c.invitesPausedAt) throw forbidden(PAUSED_MESSAGE);
    if (c.minAccountAgeHours > 0) {
      const [me] = await tx.select({ createdAt: user.createdAt }).from(user).where(eq(user.id, userId));
      if (me && me.createdAt.getTime() > Date.now() - c.minAccountAgeHours * 3_600_000) {
        throw forbidden("Your account is too new to join this community. Try again later.");
      }
    }
    if (c.raidJoinLimit > 0) {
      const since = new Date(Date.now() - RAID_WINDOW_MINUTES * 60_000);
      const [{ recent }] = await tx.select({ recent: count() }).from(member)
        .where(and(eq(member.communityId, c.id), gt(member.joinedAt, since), ne(member.userId, c.ownerId)));
      if (recent >= c.raidJoinLimit) {
        await tx.update(community).set({ invitesPausedAt: new Date() }).where(eq(community.id, c.id));
        await tx.insert(auditLog).values({ communityId: c.id, actorId: null, action: "invites.auto_pause", reason: `${recent} joins in ${RAID_WINDOW_MINUTES} minutes` });
        // Returned, not thrown, so the pause commits.
        return { raid: true as const };
      }
    }
    await tx.insert(member).values({ communityId: row.communityId, userId, rulesAcceptedVersion: c.rulesRequired ? c.rulesVersion : 0 });
    await tx.update(invite).set({ uses: sql`${invite.uses} + 1` }).where(eq(invite.code, code));
    return { communityId: row.communityId };
  });
  if ("raid" in result) throw forbidden(PAUSED_MESSAGE);
  return result.communityId;
}

// --- Safety settings --------------------------------------------------------

export interface CommunitySafety {
  invitesPaused: boolean;
  minAccountAgeHours: number;
  raidJoinLimit: number;
}

export const ACCOUNT_AGE_OPTIONS = [0, 1, 24, 168] as const;
export const RAID_LIMIT_OPTIONS = [0, 10, 30, 100] as const;

// Partial: forms send only what changed, so a stale form can't undo an automatic raid pause.
const safetyInput = z.object({
  invitesPaused: z.boolean(),
  minAccountAgeHours: z.union(ACCOUNT_AGE_OPTIONS.map((n) => z.literal(n))),
  raidJoinLimit: z.union(RAID_LIMIT_OPTIONS.map((n) => z.literal(n))),
}).partial();

export async function getCommunitySafety(userId: string, rawCommunityId: unknown): Promise<CommunitySafety> {
  const communityId = parse(uuid, rawCommunityId);
  const { community: c } = await requireMember(db, communityId, userId, Permission.ManageCommunity);
  return { invitesPaused: c.invitesPausedAt !== null, minAccountAgeHours: c.minAccountAgeHours, raidJoinLimit: c.raidJoinLimit };
}

export async function updateCommunitySafety(userId: string, rawCommunityId: unknown, rawInput: unknown): Promise<void> {
  // Partial updates: omitted fields keep their current value.
  const communityId = parse(uuid, rawCommunityId);
  const input = parse(safetyInput, rawInput);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    const { community: c } = await requireMember(tx, communityId, userId, Permission.ManageCommunity);
    const wasPaused = c.invitesPausedAt !== null;
    const paused = input.invitesPaused ?? wasPaused;
    const minAccountAgeHours = input.minAccountAgeHours ?? c.minAccountAgeHours;
    const raidJoinLimit = input.raidJoinLimit ?? c.raidJoinLimit;
    await tx.update(community).set({ invitesPausedAt: paused ? (c.invitesPausedAt ?? new Date()) : null, minAccountAgeHours, raidJoinLimit })
      .where(eq(community.id, communityId));
    if (paused !== wasPaused) {
      await tx.insert(auditLog).values({ communityId, actorId: userId, action: paused ? "invites.pause" : "invites.resume" });
    }
    if (minAccountAgeHours !== c.minAccountAgeHours || raidJoinLimit !== c.raidJoinLimit) {
      await tx.insert(auditLog).values({
        communityId, actorId: userId, action: "community.safety",
        reason: `minimum account age ${minAccountAgeHours} h, raid limit ${raidJoinLimit || "off"}`,
      });
    }
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
