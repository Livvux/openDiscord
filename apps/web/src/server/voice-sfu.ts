// Internal generation-room ownership only. SDK requests never run inside a SQL transaction.
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { RoomServiceClient, ServerError, TrackSource } from "livekit-server-sdk";
import { db } from "@/db";
import { channel, dmDevice, session, userBlock } from "@/db/schema";
import { voiceCall, voiceCallMember, voiceSfuRoom } from "@/db/voice-schema";
import { parseVoiceRoomName, voiceRoomName } from "@/lib/voice/room";
import { loadChannelAuthority, lockCommunity } from "./access";
import { AppError, forbidden } from "./errors";
import { assertActiveUser } from "./instance-policy";
import { has, Permission } from "./permissions";
import { lockVoiceLifecycle } from "./voice-locks";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type OwnedRoom = typeof voiceSfuRoom.$inferSelect;
type Outcome = OwnedRoom["lastOutcome"];
export const VOICE_SFU_ROOM_CAPACITY = 100_000;
const REQUEST_SECONDS = 0.5;
const LEASE_MS = 30_000;
const RECHECK_MS = 300_000;
const ACTIVE_RECHECK_MS = 30_000;

export function voiceRoomService(): RoomServiceClient | null {
  const url = process.env.LIVEKIT_API_URL || process.env.LIVEKIT_URL?.replace(/^ws/, "http");
  const key = process.env.LIVEKIT_API_KEY, secret = process.env.LIVEKIT_API_SECRET;
  return url && key && secret ? new RoomServiceClient(url, key, secret, { requestTimeout: REQUEST_SECONDS, failover: false }) : null;
}

/** Caller holds Voice and canonical call authority locks. Existing reservations never COUNT. */
export async function reserveVoiceRoom(tx: Tx, binding: { channelId: string; callId: string; generation: number }, expiresAt: Date) {
  const roomName = voiceRoomName(binding);
  const [existing] = await tx.select().from(voiceSfuRoom).where(eq(voiceSfuRoom.roomName, roomName));
  if (existing) {
    if (existing.status === "retired") throw forbidden("This voice room has ended. Refresh the current call.");
    await tx.update(voiceSfuRoom).set({ lastAppTokenExpiry: sql`greatest(${voiceSfuRoom.lastAppTokenExpiry}, ${expiresAt})` }).where(eq(voiceSfuRoom.roomName, roomName));
    return;
  }
  if (await tx.$count(voiceSfuRoom) >= VOICE_SFU_ROOM_CAPACITY) throw new AppError("conflict", "Voice room capacity requires operator review.");
  await tx.insert(voiceSfuRoom).values({ roomName, ...binding, lastAppTokenExpiry: expiresAt });
}

async function retire(tx: Tx, name: string) {
  await tx.update(voiceSfuRoom).set({ status: "retired", retiredAt: new Date(), nextAttemptAt: new Date(), leaseToken: null, leaseUntil: null })
    .where(and(eq(voiceSfuRoom.roomName, name), eq(voiceSfuRoom.status, "active")));
}
export async function retireOwnedVoiceRoom(name: string): Promise<void> {
  await db.transaction(async tx => { await lockVoiceLifecycle(tx); await retire(tx, name); });
}

/** Fresh canonical authority, independent of sweep eligibility and repaired after native cascades. */
async function roomAuthority(name: string) {
  return db.transaction(async tx => {
    await lockVoiceLifecycle(tx);
    const [owned] = await tx.select().from(voiceSfuRoom).where(eq(voiceSfuRoom.roomName, name));
    if (!owned || !parseVoiceRoomName(name)) return null;
    if (owned.status === "retired") return { owned, members: null };
    const [ref] = await tx.select({ call: voiceCall, communityId: channel.communityId }).from(voiceCall)
      .innerJoin(channel, eq(channel.id, voiceCall.channelId)).where(eq(voiceCall.id, owned.callId));
    if (!ref || ref.call.channelId !== owned.channelId || ref.call.status !== "active" || ref.call.generation !== owned.generation) {
      await retire(tx, name);
      return { owned: { ...owned, status: "retired" as const }, members: null };
    }
    await lockCommunity(tx, ref.communityId);
    await tx.select({ id: voiceCall.id }).from(voiceCall).where(eq(voiceCall.id, owned.callId)).for("update");
    const members = await tx.select().from(voiceCallMember).where(and(eq(voiceCallMember.callId, owned.callId), ne(voiceCallMember.state, "left"))).orderBy(asc(voiceCallMember.id)).limit(9);
    const ids = members.map(member => member.userId);
    const blocked = ids.length > 1 ? await tx.select({ id: userBlock.blockerId }).from(userBlock).where(and(inArray(userBlock.blockerId, ids), inArray(userBlock.blockedId, ids))).limit(1) : [];
    const sessionExpiries: Date[] = [];
    const allowed: { identity: string; sources: TrackSource[] }[] = [];
    let valid = members.length > 0 && members.length <= 8 && !blocked.length;
    for (const member of members) {
      const now = new Date();
      const [s] = await tx.select({ id: session.id, expiresAt: session.expiresAt }).from(session).where(and(eq(session.id, member.sessionId), eq(session.userId, member.userId), gt(session.expiresAt, now))).for("share");
      if (s) sessionExpiries.push(s.expiresAt);
      const [anchor] = await tx.select({ id: dmDevice.id }).from(dmDevice).where(and(eq(dmDevice.id, member.anchorDeviceId), eq(dmDevice.userId, member.userId), isNull(dmDevice.revokedAt))).for("share");
      let access: Awaited<ReturnType<typeof loadChannelAuthority>> = null;
      try { access = await loadChannelAuthority(tx, owned.channelId, member.userId); }
      catch (error) { if (!(error instanceof AppError)) throw error; valid = false; }
      try { await assertActiveUser(member.userId, tx); } catch (error) { if (!(error instanceof AppError)) throw error; valid = false; }
      if (!s || !anchor || member.voiceUserId !== `@voice_${owned.callId}_${member.id}:opendiscord.local` || member.leaseExpiresAt <= now || !access || access.channel.kind !== "voice" || !has(access.authority, Permission.Connect)) { valid = false; continue; }
      allowed.push({ identity: `v1:${member.id}`, sources: [
        ...(has(access.authority, Permission.Speak) ? [TrackSource.MICROPHONE] : []),
        ...(has(access.authority, Permission.Video) ? [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : []),
      ] });
    }
    const cutoff = new Date();
    if (members.some(member => member.leaseExpiresAt <= cutoff) || sessionExpiries.some(expiresAt => expiresAt <= cutoff)) valid = false;
    if (!valid) { await retire(tx, name); return { owned: { ...owned, status: "retired" as const }, members: null }; }
    return { owned, members: allowed };
  });
}

/** Final locked check also observes retirement performed by the preceding postcommit consumer. */
export async function assertOwnedVoiceRoomActive(name: string): Promise<void> {
  const authority = await roomAuthority(name);
  if (!authority || authority.owned.status !== "active") throw forbidden("This voice room has ended.");
}

/** Explicit server creation follows reservation COMMIT; caller revalidates enrollment again before JWT. */
export async function createOwnedVoiceRoom(name: string): Promise<void> {
  await assertOwnedVoiceRoomActive(name);
  const client = voiceRoomService();
  try {
    if (!client) throw new Error("unavailable");
    await client.createRoom({ name });
  } catch {
    await retireOwnedVoiceRoom(name);
    await consumeVoiceRooms();
    throw new AppError("conflict", "Voice is temporarily unavailable. Refresh the current call.");
  }
}

function notFound(error: unknown): boolean { return error instanceof ServerError && error.code === "not_found"; }

export interface VoiceRoomCleanup { claimed: number; requests: number; retired: number; deleted: number; failed: number; unavailable: number; limited: boolean }
/** Persistent leases recover crashes; successful deletion remains due for exact recurring rechecks. */
export async function consumeVoiceRooms({ maxRooms = 4, maxRequests = 4, maxMilliseconds = 2500 }: { maxRooms?: number; maxRequests?: number; maxMilliseconds?: number } = {}): Promise<VoiceRoomCleanup> {
  const result: VoiceRoomCleanup = { claimed: 0, requests: 0, retired: 0, deleted: 0, failed: 0, unavailable: 0, limited: false };
  const deadline = performance.now() + Math.min(Math.max(maxMilliseconds, 0), 20_000);
  const roomBudget = Math.min(Math.max(Math.floor(maxRooms), 0), 16), requestBudget = Math.min(Math.max(Math.floor(maxRequests), 0), 32);
  const canRequest = () => result.requests < requestBudget && performance.now() + REQUEST_SECONDS * 1000 <= deadline;
  try {
    const client = voiceRoomService();
    for (; result.claimed < roomBudget && canRequest();) {
      const claim = await db.transaction(async tx => {
        await lockVoiceLifecycle(tx);
        const now = new Date();
        const [row] = await tx.select().from(voiceSfuRoom).where(and(lte(voiceSfuRoom.nextAttemptAt, now), or(isNull(voiceSfuRoom.leaseUntil), lte(voiceSfuRoom.leaseUntil, now)))).orderBy(asc(voiceSfuRoom.nextAttemptAt), asc(voiceSfuRoom.roomName)).limit(1).for("update", { skipLocked: true });
        if (!row) return null;
        const leaseToken = randomUUID();
        await tx.update(voiceSfuRoom).set({ leaseToken, leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: sql`least(${voiceSfuRoom.attempts}::bigint + 1, 2147483647)::integer` }).where(eq(voiceSfuRoom.roomName, row.roomName));
        return { ...row, leaseToken };
      });
      if (!claim) return result;
      result.claimed++;
      let outcome: Outcome = "failed", retrySoon = false;
      try {
        const authority = await roomAuthority(claim.roomName);
        if (!authority) throw new Error("ownership");
        if (!client) { outcome = "unavailable"; result.unavailable++; }
        else if (authority.owned.status === "retired") {
          result.retired++;
          if (!canRequest()) retrySoon = true;
          else {
            result.requests++;
            try { await client.deleteRoom(claim.roomName); outcome = "deleted"; } catch (error) { if (!notFound(error)) throw error; outcome = "not_found"; }
            result.deleted++;
          }
        } else if (canRequest()) {
          result.requests++;
          const participants = await client.listParticipants(claim.roomName).catch(error => { if (notFound(error)) return []; throw error; });
          // Unknown/overfull rosters cannot become authority. Retirement is terminal for this generation.
          if (participants.length > 8 || participants.some(p => !authority.members?.some(m => m.identity === p.identity))) {
            await retireOwnedVoiceRoom(claim.roomName); retrySoon = true;
          } else {
            outcome = "current";
            for (const participant of participants) {
              const allowed = authority.members!.find(m => m.identity === participant.identity)!;
              const current = participant.permission;
              if (current?.canPublishData || current?.canUpdateMetadata || (current?.canPublish && allowed.sources.length === 0) || (current?.canPublishSources ?? []).some(source => !allowed.sources.includes(source))) {
                if (!canRequest()) { retrySoon = true; break; }
                result.requests++;
                await client.updateParticipant(claim.roomName, participant.identity, { permission: { canSubscribe: !!current?.canSubscribe, canPublish: !!current?.canPublish && allowed.sources.length > 0, canPublishSources: (current?.canPublishSources ?? []).filter(source => allowed.sources.includes(source)), canPublishData: false, canUpdateMetadata: false } });
              }
            }
          }
        } else retrySoon = true;
      } catch { result.failed++; }
      const delay = retrySoon ? 1000 : outcome === "current" ? ACTIVE_RECHECK_MS : outcome === "deleted" || outcome === "not_found" ? RECHECK_MS : Math.min(RECHECK_MS, 1000 * 2 ** Math.min(claim.attempts, 8));
      await db.transaction(async tx => {
        await lockVoiceLifecycle(tx);
        await tx.update(voiceSfuRoom).set({ leaseToken: null, leaseUntil: null, lastOutcome: outcome, nextAttemptAt: new Date(Date.now() + delay) })
          .where(and(eq(voiceSfuRoom.roomName, claim.roomName), eq(voiceSfuRoom.leaseToken, claim.leaseToken), gt(voiceSfuRoom.leaseUntil, new Date())));
      });
      result.limited ||= retrySoon;
    }
    result.limited = true;
  } catch { result.failed++; }
  if (result.failed || result.unavailable || result.limited) console.warn("[voice] bounded room cleanup", result);
  return result;
}

/** A rejected transaction never reaches the SFU; consumer failure cannot undo committed authority. */
export async function voiceTransaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
  const value = await db.transaction(operation);
  await consumeVoiceRooms();
  return value;
}
