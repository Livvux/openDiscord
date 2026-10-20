// Group conversations (3–8 people). Content stays end-to-end encrypted; membership and the name are server metadata.
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { dmConversation, dmMember, dmMessage } from "@/db/schema";
import { DM_GROUP_MAX_MEMBERS, DM_GROUP_NAME_MAX } from "@/lib/dm/contracts";
import { advanceRead, announce, assertConversationCapacity, blocked, conversationFor } from "./direct-messages";
import { forbidden, invalid } from "./errors";
import { areFriends } from "./friends";
import { assertActiveUser } from "./instance-policy";
import { consume } from "./limits";
import { parse, uuid } from "./validation";
import { invalidateVoiceMembership } from "./voice-control";
import { lockVoiceLifecycle } from "./voice-locks";
import { voiceTransaction } from "./voice-sfu";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const person = z.string().min(1).max(64);
const groupName = z.string().trim().max(DM_GROUP_NAME_MAX).transform((name) => name || null);
const lockGroup = (tx: Tx, id: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 34))`);

/**
 * Only your own friends can be added (no consent step, as on Discord; leaving is the remedy), and never into a
 * group where anyone already there, or anyone added with them, has a block with them in either direction.
 */
async function assertAddable(tx: Tx, actor: string, ids: string[], members: string[]): Promise<void> {
  for (const id of ids) {
    if (id === actor || !(await areFriends(tx, actor, id)) || await blocked(tx, actor, id)) throw invalid("Add only your friends to a group.");
    await assertActiveUser(id, tx);
  }
  for (const [index, id] of ids.entries()) {
    for (const other of [...members, ...ids.slice(index + 1)]) if (other !== actor && await blocked(tx, id, other)) throw invalid("Someone in this group has a block with a person you are adding.");
  }
}
async function groupFor(tx: Tx, actor: string, id: string) {
  const row = await conversationFor(tx, actor, id);
  if (row.kind !== "group") throw invalid("This is not a group conversation.");
  return row;
}

export async function createGroupConversation(actor: string, input: unknown): Promise<string> {
  const data = parse(z.object({ members: z.array(person).max(DM_GROUP_MAX_MEMBERS - 1, `A group has at most ${DM_GROUP_MAX_MEMBERS} people.`), name: groupName.optional() }).strict(), input);
  const members = [...new Set(data.members)].filter((id) => id !== actor);
  if (members.length < 2) throw invalid("A group needs at least two other people.");
  await consume(`dm-request:${actor}`, 10, 3_600_000);
  const id = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actor}, 31))`);
    for (const userId of [actor, ...members]) await assertConversationCapacity(tx, userId);
    await assertAddable(tx, actor, members, []);
    const [created] = await tx.insert(dmConversation).values({ kind: "group", status: "accepted", requestedBy: actor, name: data.name ?? null }).returning({ id: dmConversation.id });
    await tx.insert(dmMember).values([actor, ...members].map((userId) => ({ conversationId: created.id, userId })));
    return created.id;
  });
  await announce(id, [actor, ...members], "request");
  return id;
}

/** Any member adds their own friends. New members start after the existing (unreadable to them) history. */
export async function addGroupMembers(actor: string, id: string, rawMembers: unknown): Promise<void> {
  const added = [...new Set(parse(z.array(person).min(1).max(DM_GROUP_MAX_MEMBERS), rawMembers))];
  const everyone = await db.transaction(async (tx) => {
    await lockGroup(tx, parse(uuid, id));
    const group = await groupFor(tx, actor, id);
    const fresh = added.filter((userId) => userId !== actor && !group.others.includes(userId));
    if (!fresh.length) return null;
    if (group.others.length + 1 + fresh.length > DM_GROUP_MAX_MEMBERS) throw invalid(`A group has at most ${DM_GROUP_MAX_MEMBERS} people.`);
    const removed = await tx.select({ id: dmMember.userId }).from(dmMember).where(and(eq(dmMember.conversationId, group.id), inArray(dmMember.userId, fresh), isNotNull(dmMember.removedAt)));
    if (removed.length && group.owner !== actor) throw forbidden("Only the group owner can add back someone they removed.");
    await assertAddable(tx, actor, fresh, group.others);
    for (const userId of fresh) await assertConversationCapacity(tx, userId);
    // Database time, like dm_message.created_at, which the history cut-off compares against.
    await tx.insert(dmMember).values(fresh.map((userId) => ({ conversationId: group.id, userId })))
      .onConflictDoUpdate({ target: [dmMember.conversationId, dmMember.userId], set: { joinedAt: sql`now()`, leftAt: null, removedAt: null } });
    const [latest] = await tx.select({ id: dmMessage.id }).from(dmMessage).where(eq(dmMessage.conversationId, group.id)).orderBy(desc(dmMessage.id)).limit(1);
    if (latest) for (const userId of fresh) await advanceRead(tx, group.id, userId, latest.id);
    return [actor, ...group.others, ...fresh];
  });
  if (everyone) await announce(id, everyone, "request");
}

/** Leaving (or being removed) is immediate: the server stops listing messages, key traffic and the group's call for that person. */
async function depart(actor: string, id: string, target: string): Promise<void> {
  // Voice before the group lock (the Voice lock order); the call membership ends in the same commit.
  const everyone = await voiceTransaction(async (tx) => {
    await lockVoiceLifecycle(tx);
    await lockGroup(tx, parse(uuid, id));
    const group = await groupFor(tx, actor, id);
    if (target !== actor) {
      if (group.owner !== actor) throw forbidden("Only the group owner can remove people.");
      if (!group.others.includes(target)) throw invalid("This person is not in the group.");
    }
    // Ownership passes to the longest-standing remaining member; a later rejoin does not take it back.
    if (target === group.owner) await tx.update(dmConversation).set({ requestedBy: group.others.find((id) => id !== target) ?? null }).where(eq(dmConversation.id, group.id));
    await invalidateVoiceMembership(tx, { conversationId: group.id, userId: target }, target === actor ? "conversation-left" : "conversation-removed");
    // The last member leaving deletes the group (database trigger dm_member_cleanup).
    await tx.update(dmMember).set({ leftAt: new Date(), removedAt: target === actor ? null : new Date() }).where(and(eq(dmMember.conversationId, group.id), eq(dmMember.userId, target), isNull(dmMember.leftAt)));
    return [actor, ...group.others];
  });
  await announce(id, everyone, "request");
}
export const leaveGroup = (actor: string, id: string) => depart(actor, id, actor);
export const removeGroupMember = (actor: string, id: string, target: unknown) => depart(actor, id, parse(person, target));

/** Any member renames; the name is plaintext metadata. An empty name falls back to the member list. */
export async function renameGroup(actor: string, id: string, rawName: unknown): Promise<void> {
  const name = parse(groupName, rawName);
  const everyone = await db.transaction(async (tx) => {
    await lockGroup(tx, parse(uuid, id));
    const group = await groupFor(tx, actor, id);
    await tx.update(dmConversation).set({ name }).where(eq(dmConversation.id, group.id));
    return [actor, ...group.others];
  });
  await announce(id, everyone, "request");
}
