// Community onboarding: members pick interest roles for themselves after joining. Only harmless roles
// qualify (access bits, no moderation), ranked below every moderating role so picking one never
// shields anyone from moderators. Both rules are checked when configuring and again when picking,
// because roles can change in between.
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, member, memberRole, onboardingOption, role } from "@/db/schema";
import { loadMember, lockCommunity, requireMember, type Db } from "./access";
import { invalid, notFound } from "./errors";
import { canManageRole, Permission, SELF_ASSIGNABLE } from "./permissions";
import { afterAccessChange } from "./voice";
import { captureVoiceCapabilities, invalidateLostVoiceCapabilities } from "./voice-control";
import { lockVoiceLifecycle } from "./voice-locks";
import { voiceTransaction } from "./voice-sfu";
import { parse, uuid } from "./validation";

export const MAX_ONBOARDING_OPTIONS = 20;
const MODERATING = Permission.Administrator | Permission.ManageCommunity | Permission.ManageChannels | Permission.ManageRoles
  | Permission.ManageMessages | Permission.KickMembers | Permission.BanMembers | Permission.ViewAuditLog;

const optionsSchema = z.array(z.object({
  roleId: uuid,
  label: z.string().trim().min(1, "Give each option a label.").max(48, "Use at most 48 characters."),
})).max(MAX_ONBOARDING_OPTIONS, `At most ${MAX_ONBOARDING_OPTIONS} options.`);

export interface OnboardingOptionView { id: string; roleId: string; label: string; selected: boolean }
export interface OnboardingState { options: OnboardingOptionView[]; pending: boolean }

type RoleRow = typeof role.$inferSelect;

/** Why a role can't be offered, or null when it can. */
function unsafe(r: RoleRow, roles: readonly RoleRow[]): string | null {
  if (r.isDefault) return "Everyone already has the default role.";
  if (r.permissions & ~SELF_ASSIGNABLE) return `${r.name} carries moderation permissions.`;
  const lowestModerator = Math.min(...roles.filter((o) => !o.isDefault && (o.permissions & MODERATING)).map((o) => o.position));
  if (r.position >= lowestModerator) return `${r.name} must rank below every moderating role.`;
  return null;
}

async function communityRoles(tx: Db, communityId: string) {
  return tx.select().from(role).where(eq(role.communityId, communityId));
}

export async function getOnboarding(userId: string, rawCommunityId: unknown): Promise<OnboardingState> {
  const communityId = parse(uuid, rawCommunityId);
  await requireMember(db, communityId, userId);
  const [options, own, [m]] = await Promise.all([
    db.select().from(onboardingOption).where(eq(onboardingOption.communityId, communityId)).orderBy(asc(onboardingOption.position)),
    db.select({ roleId: memberRole.roleId }).from(memberRole).where(and(eq(memberRole.communityId, communityId), eq(memberRole.userId, userId))),
    db.select({ onboardedAt: member.onboardedAt }).from(member).where(and(eq(member.communityId, communityId), eq(member.userId, userId))),
  ]);
  const held = new Set(own.map((r) => r.roleId));
  return {
    options: options.map((o) => ({ id: o.id, roleId: o.roleId, label: o.label, selected: held.has(o.roleId) })),
    pending: options.length > 0 && !m?.onboardedAt,
  };
}

/** Replaces the community's options. Needs Manage roles and authority over each offered role. */
export async function setOnboardingOptions(userId: string, rawCommunityId: unknown, rawOptions: unknown): Promise<void> {
  const communityId = parse(uuid, rawCommunityId);
  const options = parse(optionsSchema, rawOptions);
  if (new Set(options.map((o) => o.roleId)).size !== options.length) throw invalid("Offer each role once.");
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    const { authority } = await requireMember(tx, communityId, userId, Permission.ManageRoles);
    const roles = await communityRoles(tx, communityId);
    for (const o of options) {
      const r = roles.find((x) => x.id === o.roleId);
      if (!r) throw notFound("Role not found.");
      const reason = unsafe(r, roles);
      if (reason) throw invalid(reason);
      if (!canManageRole(authority, r.position, r.permissions)) throw invalid(`You can't offer ${r.name}.`);
    }
    await tx.delete(onboardingOption).where(eq(onboardingOption.communityId, communityId));
    if (options.length) await tx.insert(onboardingOption).values(options.map((o, i) => ({ communityId, roleId: o.roleId, label: o.label, position: i })));
    await tx.insert(auditLog).values({ communityId, actorId: userId, action: "onboarding.update" });
  });
}

/** The member's answer: picked options' roles are added, other offered roles removed. An empty pick skips. */
export async function chooseOnboarding(userId: string, rawCommunityId: unknown, rawOptionIds: unknown): Promise<void> {
  const communityId = parse(uuid, rawCommunityId);
  const optionIds = parse(z.array(uuid).max(MAX_ONBOARDING_OPTIONS), rawOptionIds);
  await voiceTransaction(async (tx) => {
    await lockVoiceLifecycle(tx);
    await lockCommunity(tx, communityId);
    if (!(await loadMember(tx, communityId, userId))) throw notFound("Community not found.");
    const [options, roles] = await Promise.all([
      tx.select().from(onboardingOption).where(eq(onboardingOption.communityId, communityId)),
      communityRoles(tx, communityId),
    ]);
    if (optionIds.some((id) => !options.some((o) => o.id === id))) throw notFound("That option no longer exists.");
    const picked = options.filter((o) => optionIds.includes(o.id));
    for (const o of picked) {
      const reason = unsafe(roles.find((r) => r.id === o.roleId)!, roles);
      if (reason) throw invalid("This option is no longer available. Ask a moderator to review onboarding.");
    }
    const beforeVoice = await captureVoiceCapabilities(tx, { communityId, userId });
    const dropped = options.filter((o) => !optionIds.includes(o.id)).map((o) => o.roleId);
    if (dropped.length) await tx.delete(memberRole).where(and(eq(memberRole.communityId, communityId), eq(memberRole.userId, userId), inArray(memberRole.roleId, dropped)));
    if (picked.length) await tx.insert(memberRole).values(picked.map((o) => ({ communityId, userId, roleId: o.roleId }))).onConflictDoNothing();
    await tx.update(member).set({ onboardedAt: new Date() }).where(and(eq(member.communityId, communityId), eq(member.userId, userId)));
    await invalidateLostVoiceCapabilities(tx, beforeVoice);
  });
  await afterAccessChange(communityId);
}

/** Shows the picker again. */
export async function reopenOnboarding(userId: string, rawCommunityId: unknown): Promise<void> {
  const communityId = parse(uuid, rawCommunityId);
  await requireMember(db, communityId, userId);
  await db.update(member).set({ onboardedAt: null }).where(and(eq(member.communityId, communityId), eq(member.userId, userId)));
}
