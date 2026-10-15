// Basic per-community AutoMod: refuse messages with blocked words or links. People who can manage
// messages are exempt (they moderate; they aren't moderated by the filter). Refusals are audited without
// the message content.
import { and, count, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, community } from "@/db/schema";
import { lockCommunity, requireMember } from "./access";
import { AppError } from "./errors";
import { has, Permission, type MemberAuthority } from "./permissions";
import { parse, uuid } from "./validation";

export interface AutomodRules {
  words: string[];
  blockLinks: boolean;
}

export type AutomodViolation = "word" | "link";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LINK = /\bhttps?:\/\/|\bwww\.[\p{L}\p{N}-]+\./iu;

/** Which rule `content` breaks, if any. Words match whole words, case- and width-insensitively. */
export function automodViolation(content: string, rules: AutomodRules): AutomodViolation | null {
  const text = content.normalize("NFKC").toLowerCase();
  if (rules.blockLinks && LINK.test(text)) return "link";
  for (const word of rules.words) {
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}(?![\\p{L}\\p{N}])`, "u").test(text)) return "word";
  }
  return null;
}

const MESSAGES: Record<AutomodViolation, string> = {
  word: "This community's AutoMod blocked your message because it contains a blocked word.",
  link: "This community's AutoMod doesn't allow links in messages.",
};
/** At most this many AutoMod audit entries per person per minute, so retries can't flood the log. */
const AUDIT_PER_MINUTE = 3;

/** Throws if the message breaks the community's rules and the author isn't exempt. */
export async function enforceAutomod(communityId: string, authorId: string, authority: MemberAuthority, content: string): Promise<void> {
  if (!content || has(authority, Permission.ManageMessages)) return;
  const [rules] = await db
    .select({ words: community.automodWords, blockLinks: community.automodBlockLinks })
    .from(community)
    .where(eq(community.id, communityId));
  const violation = rules ? automodViolation(content, rules) : null;
  if (!violation) return;
  const [{ recent }] = await db.select({ recent: count() }).from(auditLog).where(and(
    eq(auditLog.communityId, communityId), eq(auditLog.actorId, authorId), eq(auditLog.action, "automod.block"),
    gt(auditLog.createdAt, new Date(Date.now() - 60_000)),
  ));
  if (recent < AUDIT_PER_MINUTE) {
    await db.insert(auditLog).values({ communityId, actorId: authorId, action: "automod.block", reason: violation === "word" ? "blocked word" : "link" });
  }
  throw new AppError("forbidden", MESSAGES[violation]);
}

export const MAX_AUTOMOD_WORDS = 100;

const rulesInput = z.object({
  words: z
    .array(z.string().trim().toLowerCase().normalize("NFKC").min(1).max(32, "Blocked words can have at most 32 characters."))
    .max(MAX_AUTOMOD_WORDS, `Use at most ${MAX_AUTOMOD_WORDS} blocked words.`)
    .transform((words) => [...new Set(words)]),
  blockLinks: z.boolean(),
});

export async function getAutomod(userId: string, rawCommunityId: unknown): Promise<AutomodRules> {
  const communityId = parse(uuid, rawCommunityId);
  const { community: c } = await requireMember(db, communityId, userId, Permission.ManageCommunity);
  return { words: c.automodWords, blockLinks: c.automodBlockLinks };
}

export async function updateAutomod(userId: string, rawCommunityId: unknown, rawRules: unknown): Promise<void> {
  const communityId = parse(uuid, rawCommunityId);
  const rules = parse(rulesInput, rawRules);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    await requireMember(tx, communityId, userId, Permission.ManageCommunity);
    await tx.update(community).set({ automodWords: rules.words, automodBlockLinks: rules.blockLinks }).where(eq(community.id, communityId));
    // The word list itself stays out of the log: it may contain slurs that moderators don't want repeated.
    await tx.insert(auditLog).values({
      communityId, actorId: userId, action: "automod.update",
      reason: `${rules.words.length} blocked ${rules.words.length === 1 ? "word" : "words"}, links ${rules.blockLinks ? "blocked" : "allowed"}`,
    });
  });
}
