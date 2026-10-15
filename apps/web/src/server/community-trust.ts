import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, ban, banAppeal, community, member, user } from "@/db/schema";
import { loadAuthority, lockCommunity, requireMember, type Db } from "./access";
import { forbidden, invalid, notFound } from "./errors";
import { assertActiveUser } from "./instance-policy";
import { outranks, Permission, type MemberAuthority } from "./permissions";
import { publish } from "./realtime";
import { parse, uuid } from "./validation";

// Plain text only. React renders this text escaped; no HTML/Markdown rendering is involved.
const rulesInput = z.object({ text: z.string().trim().max(4000), required: z.boolean() });
const versionInput = z.number().int().nonnegative();
const appealInput = z.string().trim().min(1, "Explain why the ban should be reviewed.").max(2000);
const noteInput = z.string().trim().max(512);

export async function getCommunityRules(userId: string, rawCommunityId: unknown) {
  const communityId = parse(uuid, rawCommunityId);
  const { community: c } = await requireMember(db, communityId, userId);
  const [m] = await db.select({ accepted: member.rulesAcceptedVersion }).from(member)
    .where(and(eq(member.communityId, communityId), eq(member.userId, userId)));
  return { text: c.rules, version: c.rulesVersion, required: c.rulesRequired, accepted: m?.accepted === c.rulesVersion };
}

export async function updateCommunityRules(userId: string, rawCommunityId: unknown, rawInput: unknown) {
  const communityId = parse(uuid, rawCommunityId);
  const input = parse(rulesInput, rawInput);
  if (input.required && !input.text) throw invalid("Write rules before requiring acknowledgement.");
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    const { community: c } = await requireMember(tx, communityId, userId, Permission.ManageCommunity);
    if (c.rules === input.text && c.rulesRequired === input.required) return;
    await tx.update(community).set({ rules: input.text, rulesRequired: input.required, rulesVersion: c.rulesVersion + 1 }).where(eq(community.id, communityId));
    await tx.insert(auditLog).values({ communityId, actorId: userId, action: "community.rules" });
  });
  await publish({ type: "channels.changed", communityId });
}

export async function acknowledgeCommunityRules(userId: string, rawCommunityId: unknown, rawVersion: unknown) {
  const communityId = parse(uuid, rawCommunityId);
  const version = parse(versionInput, rawVersion);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    const { community: c } = await requireMember(tx, communityId, userId);
    if (version !== c.rulesVersion) throw invalid("The rules changed. Refresh and read the current version.");
    await tx.update(member).set({ rulesAcceptedVersion: version }).where(and(eq(member.communityId, communityId), eq(member.userId, userId)));
  });
}

/** Only the caller's bans. No member/channel lists or other users' appeals are returned. */
export async function listOwnRestrictions(userId: string) {
  await assertActiveUser(userId);
  const rows = await db.select({ communityId: ban.communityId, communityName: community.name, reason: ban.reason, createdAt: ban.createdAt,
    appealId: banAppeal.id, content: banAppeal.content, resolution: banAppeal.resolution, resolutionNote: banAppeal.resolutionNote })
    .from(ban).innerJoin(community, eq(community.id, ban.communityId))
    .leftJoin(banAppeal, and(eq(banAppeal.communityId, ban.communityId), eq(banAppeal.userId, ban.userId), eq(banAppeal.banId, ban.id)))
    .where(and(eq(ban.userId, userId), isNull(community.suspendedAt))).orderBy(desc(ban.createdAt));
  return rows;
}

export async function submitBanAppeal(userId: string, rawCommunityId: unknown, rawContent: unknown) {
  const communityId = parse(uuid, rawCommunityId);
  const content = parse(appealInput, rawContent);
  await assertActiveUser(userId);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    const [b] = await tx.select({ ban }).from(ban).innerJoin(community, eq(community.id, ban.communityId))
      .where(and(eq(ban.communityId, communityId), eq(ban.userId, userId), isNull(community.suspendedAt)));
    if (!b) throw notFound("Restriction not found.");
    const [created] = await tx.insert(banAppeal).values({ communityId, userId, banId: b.ban.id, content })
      .onConflictDoNothing().returning({ id: banAppeal.id });
    if (!created) throw invalid("You already submitted an appeal for this ban.");
    // Appeal content is intentionally absent from the broader audit log.
    await tx.insert(auditLog).values({ communityId, actorId: userId, action: "ban.appeal", targetId: userId });
  });
}

export async function listBanAppeals(userId: string, rawCommunityId: unknown) {
  const communityId = parse(uuid, rawCommunityId);
  await requireMember(db, communityId, userId, Permission.BanMembers);
  return db.select({ id: banAppeal.id, userId: banAppeal.userId, name: user.name, content: banAppeal.content, createdAt: banAppeal.createdAt,
    resolution: banAppeal.resolution, resolutionNote: banAppeal.resolutionNote })
    .from(banAppeal).innerJoin(user, eq(user.id, banAppeal.userId)).where(eq(banAppeal.communityId, communityId))
    .orderBy(desc(banAppeal.createdAt)).limit(100);
}

/** Also used by the ordinary unban path: both paths must respect the issuer's current rank. */
export async function requireBanReviewAuthority(tx: Db, communityId: string, actorId: string, authority: MemberAuthority, moderatorId: string | null) {
  if (moderatorId && moderatorId !== actorId) {
    const issuer = await loadAuthority(tx, communityId, moderatorId);
    if (issuer && !outranks(authority, issuer) && !authority.isOwner) throw forbidden("This ban was issued by someone ranked above you.");
  }
}

export async function resolveBanAppeal(userId: string, rawCommunityId: unknown, rawAppealId: unknown, rawResolution: unknown, rawNote: unknown) {
  const communityId = parse(uuid, rawCommunityId);
  const appealId = parse(uuid, rawAppealId);
  const resolution = parse(z.enum(["uphold", "unban"]), rawResolution);
  const note = parse(noteInput, rawNote);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    const { authority } = await requireMember(tx, communityId, userId, Permission.BanMembers);
    const [appeal] = await tx.select().from(banAppeal).where(and(eq(banAppeal.id, appealId), eq(banAppeal.communityId, communityId), isNull(banAppeal.resolvedAt)));
    if (!appeal) throw notFound("Pending appeal not found.");
    const [b] = await tx.select().from(ban).where(and(eq(ban.communityId, communityId), eq(ban.userId, appeal.userId), eq(ban.id, appeal.banId)));
    if (!b) throw notFound("Restriction not found.");
    await requireBanReviewAuthority(tx, communityId, userId, authority, b.moderatorId);
    if (resolution === "unban") {
      await tx.delete(ban).where(and(eq(ban.communityId, communityId), eq(ban.userId, appeal.userId)));
      await tx.insert(auditLog).values({ communityId, actorId: userId, action: "member.unban", targetId: appeal.userId });
    }
    await tx.update(banAppeal).set({ resolvedAt: new Date(), resolvedBy: userId, resolution, resolutionNote: note || null }).where(eq(banAppeal.id, appealId));
    await tx.insert(auditLog).values({ communityId, actorId: userId, action: `ban.appeal.${resolution}`, targetId: appeal.userId });
  });
}

/** Resolved decisions remain available to their appellant after a ban is removed. */
export async function listOwnAppealHistory(userId: string) {
  await assertActiveUser(userId);
  return db.select({ id: banAppeal.id, communityName: community.name, content: banAppeal.content, resolution: banAppeal.resolution, resolutionNote: banAppeal.resolutionNote })
    .from(banAppeal).innerJoin(community, eq(community.id, banAppeal.communityId))
    .where(and(eq(banAppeal.userId, userId), isNull(community.suspendedAt)))
    .orderBy(desc(banAppeal.createdAt)).limit(100);
}
