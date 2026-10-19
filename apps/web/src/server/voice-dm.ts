// Direct-message call context: who may take part in a conversation's encrypted call, and content-free ringing.
// Runs inside Voice transactions (Voice lock held); DM rows are only read here, never locked.
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { dmConversation, dmMember, userBlock } from "@/db/schema";
import type { VoiceMediaSource } from "@/lib/voice/contracts";
import { conversationFor } from "./direct-messages";
import { AppError } from "./errors";
import { publish } from "./realtime";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Every participant of a DM call may speak, show video and share a screen (screen audio stays refused client-side). */
export const DM_CALL_SOURCES: VoiceMediaSource[] = ["microphone", "camera", "screen_share", "screen_share_audio"];

/**
 * Exactly the rule for sending a message now (`conversationFor(..., sending)`): an accepted 1:1 conversation
 * without a block in either direction and whose peer is active, or a current (not left/removed) group member
 * whose own account is active. Blocks between call participants are refused separately for every call.
 */
export async function requireDmCall(tx: Tx, conversationId: string, userId: string): Promise<void> {
  await conversationFor(tx, userId, conversationId, true);
}
export async function dmCallAllowed(tx: Tx, conversationId: string, userId: string): Promise<boolean> {
  try { await requireDmCall(tx, conversationId, userId); return true; }
  catch (error) { if (error instanceof AppError) return false; throw error; }
}

/** Current people of the conversation (1:1 participants, or group members who have not left). */
async function currentPeople(tx: Tx, conversationId: string): Promise<string[]> {
  const [row] = await tx.select().from(dmConversation).where(eq(dmConversation.id, conversationId));
  if (!row) return [];
  if (row.kind === "direct") return [row.firstId!, row.secondId!];
  return (await tx.select({ id: dmMember.userId }).from(dmMember).where(and(eq(dmMember.conversationId, conversationId), isNull(dmMember.leftAt)))).map((m) => m.id);
}

/** Rings everyone else who could answer: never the caller, never someone with a block either way. Delivered on commit. */
export async function ringDmCall(tx: Tx, conversationId: string, callerId: string): Promise<string[]> {
  const others = (await currentPeople(tx, conversationId)).filter((id) => id !== callerId);
  if (!others.length) return [];
  const blocked = new Set((await tx.select({ blocker: userBlock.blockerId, blocked: userBlock.blockedId }).from(userBlock)
    .where(or(and(eq(userBlock.blockerId, callerId), inArray(userBlock.blockedId, others)), and(inArray(userBlock.blockerId, others), eq(userBlock.blockedId, callerId)))))
    .map((b) => (b.blocker === callerId ? b.blocked : b.blocker)));
  const targets = others.filter((id) => !blocked.has(id));
  for (const userId of targets) await publish({ type: "dm.call", userId, conversationId, callerId, state: "ringing" }, tx);
  return targets;
}

/** Tells current members that the conversation's call has ended (a ringing call becomes a missed call). */
export async function announceDmCallEnded(tx: Tx, conversationId: string): Promise<void> {
  for (const userId of await currentPeople(tx, conversationId)) await publish({ type: "dm.call", userId, conversationId, state: "ended" }, tx);
}
