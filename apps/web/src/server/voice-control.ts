// Unactivated internal draft: no transport, SFU client, tokens, timers or lifecycle hooks.
import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { channel, dmDevice, session, user, userBlock } from "@/db/schema";
import { voiceCall, voiceCallMember, voiceControlMailbox, voiceControlReceipt, voiceIdentity, voicePrekey, voiceSignature } from "@/db/voice-schema";
import { VOICE_DOMAIN, VOICE_LIMITS as L, voiceBindingSchema, voiceCryptoInputSchema, voiceDeviceKeysSchema, voiceEventSchema, voiceJoinAuthSchema, voiceJoinSchema, voiceMemberAuthSchema, voicePrekeySchema, voiceSignedObjectSchema, type VoiceBinding, type VoiceJoinAuth, type VoiceMemberAuth, type VoiceRemoval, type VoiceSnapshot } from "@/lib/voice/contracts";
import { loadChannelAuthority, lockCommunity, requireChannel } from "./access";
import { AppError, forbidden, invalid, notFound } from "./errors";
import { assertActiveUser } from "./instance-policy";
import { consume } from "./limits";
import { has, Permission } from "./permissions";
import { parse } from "./validation";
import { lockVoiceLifecycle as lockVoice } from "./voice-locks";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Call = typeof voiceCall.$inferSelect;
type Member = typeof voiceCallMember.$inferSelect;
type Json = Record<string, unknown>;
const object = z.record(z.string(), z.unknown());
const record = (input: unknown): Json => parse(object, input);
const conflict = (message: string) => new AppError("conflict", message);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function matchesSecret(hash: string, secret: string): boolean {
  const expected = Buffer.from(hash, "hex"), actual = Buffer.from(digest(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
const participant = (id: string) => `v1:${id}`;
const namespace = (id: string) => `@voice_${id}:${VOICE_DOMAIN}`;
// Voice-only order: advisory -> sorted community -> sorted call -> user/session/anchor SHARE.
// Never acquire DM or mutate guarded auth tables after entering this scope.
async function accountSession(tx: Tx, userId: string, sessionId: string, now: Date) {
  const [account] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("share");
  const [current] = await tx.select({ id: session.id, expiresAt: session.expiresAt }).from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId))).for("share");
  if (!account || !current || current.expiresAt <= now) throw forbidden("This account session is unavailable.");
  await assertActiveUser(userId, tx);
}
async function anchorFor(tx: Tx, userId: string, anchorId: string) {
  const [anchor] = await tx.select({ id: dmDevice.id, secretHash: dmDevice.secretHash }).from(dmDevice)
    .where(and(eq(dmDevice.id, anchorId), eq(dmDevice.userId, userId), isNull(dmDevice.revokedAt))).for("share");
  if (!anchor) throw forbidden("This enrollment anchor is unavailable.");
  return anchor;
}
async function joinAuth(tx: Tx, auth: VoiceJoinAuth, now: Date) {
  await accountSession(tx, auth.userId, auth.sessionId, now);
  const anchor = await anchorFor(tx, auth.userId, auth.anchorDeviceId);
  if (!matchesSecret(anchor.secretHash, auth.anchorSecret)) throw forbidden("This enrollment anchor is unavailable.");
}
async function liveMembers(tx: Tx, callId: string) {
  return tx.select().from(voiceCallMember).where(and(eq(voiceCallMember.callId, callId), ne(voiceCallMember.state, "left"))).orderBy(asc(voiceCallMember.id));
}
async function noBlockedPairs(tx: Tx, members: Member[], extraUserId?: string) {
  const ids = [...new Set([...members.map((m) => m.userId), ...(extraUserId ? [extraUserId] : [])])];
  if (ids.length < 2) return;
  const blocked = await tx.select({ id: userBlock.blockerId }).from(userBlock).where(and(inArray(userBlock.blockerId, ids), inArray(userBlock.blockedId, ids))).limit(1);
  if (blocked.length) throw forbidden("This voice call is unavailable.");
}
async function markLeft(tx: Tx, call: Call, rows: Member[], reason: string, now: Date): Promise<VoiceRemoval[]> {
  if (!rows.length) return [];
  const ids = rows.map((m) => m.id);
  await tx.update(voiceCallMember).set({ state: "left", leftAt: now, leaseExpiresAt: now }).where(inArray(voiceCallMember.id, ids));
  await tx.delete(voiceControlMailbox).where(eq(voiceControlMailbox.callId, call.id));
  await tx.delete(voiceControlReceipt).where(inArray(voiceControlReceipt.senderMemberId, ids));
  await tx.delete(voicePrekey).where(inArray(voicePrekey.memberId, ids));
  await tx.delete(voiceSignature).where(or(inArray(voiceSignature.signerMemberId, ids), inArray(voiceSignature.targetMemberId, ids)));
  await tx.delete(voiceIdentity).where(inArray(voiceIdentity.memberId, ids));
  const remaining = await liveMembers(tx, call.id);
  await tx.update(voiceCall).set({ generation: call.generation + 1, ...(remaining.length ? {} : { status: "closed" as const, closedAt: now }) }).where(eq(voiceCall.id, call.id));
  call.generation++;
  if (!remaining.length) { call.status = "closed"; call.closedAt = now; }
  return rows.map((m) => ({ callId: call.id, memberId: m.id, participantIdentity: participant(m.id), reason }));
}
async function expireAndRevalidate(tx: Tx, call: Call, now: Date): Promise<VoiceRemoval[]> {
  const stale: Member[] = [];
  for (const m of await liveMembers(tx, call.id)) {
    let valid = m.leaseExpiresAt > now;
    if (valid) {
      try {
        await accountSession(tx, m.userId, m.sessionId, now);
        await anchorFor(tx, m.userId, m.anchorDeviceId);
        const access = await loadChannelAuthority(tx, call.channelId, m.userId);
        valid = !!access && access.channel.kind === "voice" && has(access.authority, Permission.Connect);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        valid = false;
      }
    }
    if (!valid) stale.push(m);
  }
  const effects = await markLeft(tx, call, stale, "authorization-or-lease-expired", now);
  await closeEmptyVoiceCall(tx, call, now);
  return effects;
}
async function snapshot(tx: Tx, call: Call, own: Member, now: Date, removals: VoiceRemoval[] = []): Promise<VoiceSnapshot> {
  const members = await liveMembers(tx, call.id);
  const accounts = members.length ? await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, members.map((m) => m.userId))) : [];
  return { callId: call.id, channelId: call.channelId, generation: call.generation, memberId: own.id, joinNonce: own.joinNonce, voiceUserId: own.voiceUserId, voiceDeviceId: own.voiceDeviceId, participantIdentity: participant(own.id), leaseExpiresAt: own.leaseExpiresAt.toISOString(), serverTime: now.toISOString(), removals,
    members: members.map((m) => ({ memberId: m.id, userId: m.userId, anchorDeviceId: m.anchorDeviceId, voiceUserId: m.voiceUserId, voiceDeviceId: m.voiceDeviceId, joinNonce: m.joinNonce, participantIdentity: participant(m.id), displayName: accounts.find((a) => a.id === m.userId)?.name ?? "Member", state: m.state === "active" ? "active" : "waiting" })) };
}

export async function joinVoiceControl(rawAuth: unknown, input: unknown): Promise<VoiceSnapshot> {
  const auth = parse(voiceJoinAuthSchema, rawAuth), data = parse(voiceJoinSchema, input);
  await consume(`voice-control-join:${auth.userId}`, 30, 60_000);
  const result = await db.transaction(async (tx): Promise<VoiceSnapshot | AppError> => {
    await lockVoice(tx);
    const now = new Date();
    const [ch] = await tx.select().from(channel).where(eq(channel.id, data.channelId));
    if (!ch) throw notFound("Voice channel not found.");
    await lockCommunity(tx, ch.communityId);
    let [call] = await tx.select().from(voiceCall).where(and(eq(voiceCall.channelId, ch.id), eq(voiceCall.status, "active"))).for("update");
    await joinAuth(tx, auth, now);
    const access = await requireChannel(tx, ch.id, auth.userId, Permission.Connect);
    if (access.channel.kind !== "voice") throw invalid("This is not a voice channel.");
    const removals = call ? await expireAndRevalidate(tx, call, now) : [];
    const [previous] = await tx.select({ member: voiceCallMember, call: voiceCall }).from(voiceCallMember)
      .innerJoin(voiceCall, eq(voiceCall.id, voiceCallMember.callId)).where(and(eq(voiceCall.channelId, ch.id), eq(voiceCallMember.joinNonce, data.joinNonce)));
    if (previous) {
      const m = previous.member;
      if (m.userId !== auth.userId || m.sessionId !== auth.sessionId || m.anchorDeviceId !== auth.anchorDeviceId || m.voiceDeviceId !== data.voiceDeviceId || !matchesSecret(m.enrollmentSecretHash, data.enrollmentSecret)) return conflict("This join nonce already has a different binding.");
      if (m.state === "left" || m.leaseExpiresAt <= now || previous.call.status !== "active") return conflict("This enrollment has ended. Join with a fresh identity and nonce.");
      try { await noBlockedPairs(tx, await liveMembers(tx, m.callId)); } catch (error) { if (error instanceof AppError) return error; throw error; }
      return snapshot(tx, previous.call, m, now, removals);
    }
    const current = call?.status === "active" ? await liveMembers(tx, call.id) : [];
    try { await noBlockedPairs(tx, current, auth.userId); } catch (error) { if (error instanceof AppError) return error; throw error; }
    if (current.length >= L.members) return invalid("This call has reached its eight-device limit.");
    if (current.some((m) => m.anchorDeviceId === auth.anchorDeviceId)) return conflict("This anchor already has a live voice enrollment.");
    if (call && (await tx.select({ id: voiceCallMember.id }).from(voiceCallMember).where(and(eq(voiceCallMember.callId, call.id), eq(voiceCallMember.voiceDeviceId, data.voiceDeviceId)))).length) return conflict("This voice device ID has already been used in this call.");
    if (!call || call.status === "closed") {
      [call] = await tx.insert(voiceCall).values({ channelId: ch.id }).returning();
    }
    const { rows: [{ id }] } = await tx.execute<{ id: string }>(sql`select uuidv7() as id`);
    const [own] = await tx.insert(voiceCallMember).values({ id, callId: call.id, userId: auth.userId, anchorDeviceId: auth.anchorDeviceId, sessionId: auth.sessionId, joinNonce: data.joinNonce, voiceUserId: namespace(id), voiceDeviceId: data.voiceDeviceId, enrollmentSecretHash: digest(data.enrollmentSecret), leaseExpiresAt: new Date(now.getTime() + L.leaseMs) }).returning();
    if (current.length) {
      call.generation++;
      await tx.update(voiceCall).set({ generation: call.generation }).where(eq(voiceCall.id, call.id));
      await tx.delete(voiceControlMailbox).where(eq(voiceControlMailbox.callId, call.id));
    }
    return snapshot(tx, call, own, now, removals);
  });
  if (result instanceof AppError) throw result;
  return result;
}

// A denial after terminal cleanup is returned through the transaction, then thrown after commit.
// This keeps expiry/generation cleanup durable instead of rolling it back with the error.
type Access = { call: Call; own: Member; now: Date; removals: VoiceRemoval[] };
async function boundAccess(tx: Tx, auth: VoiceMemberAuth, binding: VoiceBinding, allowLeft = false): Promise<Access | AppError> {
  await lockVoice(tx);
  const now = new Date();
  const [ref] = await tx.select({ call: voiceCall, communityId: channel.communityId }).from(voiceCall).innerJoin(channel, eq(channel.id, voiceCall.channelId)).where(eq(voiceCall.id, binding.callId));
  if (!ref) throw notFound("Voice enrollment not found.");
  await lockCommunity(tx, ref.communityId);
  const [call] = await tx.select().from(voiceCall).where(eq(voiceCall.id, binding.callId)).for("update");
  await accountSession(tx, auth.userId, auth.sessionId, now);
  const [own] = await tx.select().from(voiceCallMember).where(and(eq(voiceCallMember.id, binding.memberId), eq(voiceCallMember.callId, call.id), eq(voiceCallMember.userId, auth.userId), eq(voiceCallMember.sessionId, auth.sessionId)));
  if (!own || auth.memberId !== own.id || own.joinNonce !== binding.joinNonce || !matchesSecret(own.enrollmentSecretHash, auth.secret)) throw forbidden("This voice enrollment is unavailable.");
  const removals = await expireAndRevalidate(tx, call, now);
  const [current] = await tx.select().from(voiceCallMember).where(eq(voiceCallMember.id, own.id));
  if (allowLeft && current.state === "left") return { call, own: current, now, removals };
  if (current.state === "left" || current.leaseExpiresAt <= now || call.status !== "active") return forbidden("This voice enrollment has ended.");
  await anchorFor(tx, own.userId, own.anchorDeviceId);
  await requireChannel(tx, call.channelId, own.userId, Permission.Connect);
  try { await noBlockedPairs(tx, await liveMembers(tx, call.id)); } catch (error) { if (error instanceof AppError) return error; throw error; }
  return { call, own: current, now, removals };
}
export async function heartbeatVoiceControl(rawAuth: unknown, input: unknown): Promise<VoiceSnapshot> {
  const auth = parse(voiceMemberAuthSchema, rawAuth), binding = parse(voiceBindingSchema, input);
  await consume(`voice-control:${auth.userId}`, 240, 60_000);
  const result = await db.transaction(async (tx) => {
    const access = await boundAccess(tx, auth, binding);
    if (access instanceof AppError) return access;
    const { call, own, now, removals } = access;
    own.leaseExpiresAt = new Date(now.getTime() + L.leaseMs);
    await tx.update(voiceCallMember).set({ leaseExpiresAt: own.leaseExpiresAt }).where(eq(voiceCallMember.id, own.id));
    // A stale generation receives the authoritative roster; this grants no media/SAS capability.
    return snapshot(tx, call, own, now, removals);
  });
  if (result instanceof AppError) throw result;
  return result;
}
export async function leaveVoiceControl(rawAuth: unknown, input: unknown): Promise<{ removals: VoiceRemoval[] }> {
  const auth = parse(voiceMemberAuthSchema, rawAuth), binding = parse(voiceBindingSchema, input);
  await consume(`voice-control:${auth.userId}`, 240, 60_000);
  const result = await db.transaction(async (tx) => {
    const access = await boundAccess(tx, auth, binding, true);
    if (access instanceof AppError) return access;
    if (access.own.state === "left") return { removals: access.removals };
    if (binding.expectedGeneration !== access.call.generation) return conflict("Voice membership changed. Refresh the current roster.");
    return { removals: [...access.removals, ...await markLeft(tx, access.call, [access.own], "leave", access.now)] };
  });
  if (result instanceof AppError) throw result;
  return result;
}

const selectorSchema = z.union([
  z.object({ communityId: z.uuid(), userId: z.string().min(1).max(128).optional() }).strict(),
  z.object({ callId: z.uuid() }).strict(), z.object({ memberId: z.uuid() }).strict(),
  z.object({ sessionId: z.string().min(1).max(128) }).strict(), z.object({ anchorDeviceId: z.uuid() }).strict(),
  z.object({ userId: z.string().min(1).max(128) }).strict(), z.object({ channelId: z.uuid() }).strict(),
]);
type Selector = z.infer<typeof selectorSchema>;
async function selectedVoiceMembers(tx: Tx, selector?: Selector) {
  const predicate = !selector ? undefined : "communityId" in selector ? and(eq(channel.communityId, selector.communityId), selector.userId ? eq(voiceCallMember.userId, selector.userId) : undefined)
    : "callId" in selector ? eq(voiceCallMember.callId, selector.callId) : "memberId" in selector ? eq(voiceCallMember.id, selector.memberId)
    : "sessionId" in selector ? eq(voiceCallMember.sessionId, selector.sessionId) : "anchorDeviceId" in selector ? eq(voiceCallMember.anchorDeviceId, selector.anchorDeviceId)
    : "userId" in selector ? eq(voiceCallMember.userId, selector.userId) : eq(voiceCall.channelId, selector.channelId);
  const selected = await tx.select({ member: voiceCallMember, call: voiceCall, communityId: channel.communityId }).from(voiceCallMember)
    .innerJoin(voiceCall, eq(voiceCall.id, voiceCallMember.callId)).innerJoin(channel, eq(channel.id, voiceCall.channelId))
    .where(and(predicate, eq(voiceCall.status, "active"), ne(voiceCallMember.state, "left"))).orderBy(asc(voiceCall.id), asc(voiceCallMember.id));
  for (const communityId of [...new Set(selected.map(r => r.communityId))].sort()) await lockCommunity(tx, communityId);
  for (const callId of [...new Set(selected.map(r => r.call.id))].sort()) await tx.select({ id: voiceCall.id }).from(voiceCall).where(eq(voiceCall.id, callId)).for("update");
  return selected;
}
/** Internal transactional invalidation. Caller enters Voice (or DM -> Voice) BEFORE its own locks.
 * Effects remain inert until call-id/member-id SFU runtime integration is reviewed and activated. */
export async function invalidateVoiceMembership(tx: Tx, rawSelector: unknown, rawReason: unknown): Promise<VoiceRemoval[]> {
  const selector = parse(selectorSchema, rawSelector), reason = parse(z.string().min(1).max(64), rawReason);
  await lockVoice(tx);
  const selected = await selectedVoiceMembers(tx, selector), effects: VoiceRemoval[] = [];
  for (const callId of [...new Set(selected.map(r => r.call.id))].sort()) {
    const [call] = await tx.select().from(voiceCall).where(eq(voiceCall.id, callId)).for("update");
    effects.push(...await markLeft(tx, call, selected.filter(r => r.call.id === callId).map(r => r.member), reason, new Date()));
  }
  return effects;
}
const voiceCapabilities = Permission.ViewChannels | Permission.Connect | Permission.Speak | Permission.Video;
async function capabilities(tx: Tx, channelId: string, userId: string) {
  try { return (await loadChannelAuthority(tx, channelId, userId))?.authority.permissions ?? 0; }
  catch (error) { if (error instanceof AppError) return 0; throw error; }
}
/** Snapshot actual effective capabilities under the same serialized mutation transaction. */
export async function captureVoiceCapabilities(tx: Tx, selector?: Selector) {
  await lockVoice(tx);
  const rows = await selectedVoiceMembers(tx, selector);
  return Promise.all(rows.map(async ({ member, call }) => ({ memberId: member.id, userId: member.userId, channelId: call.channelId, permissions: await capabilities(tx, call.channelId, member.userId) })));
}
export async function invalidateLostVoiceCapabilities(tx: Tx, before: Awaited<ReturnType<typeof captureVoiceCapabilities>>) {
  const effects: VoiceRemoval[] = [];
  for (const m of before) {
    const after = await capabilities(tx, m.channelId, m.userId);
    if ((m.permissions & voiceCapabilities & ~after) !== 0) effects.push(...await invalidateVoiceMembership(tx, { memberId: m.memberId }, "capability-lost"));
  }
  return effects;
}
/** A block closes exactly calls in which both accounts currently coexist. Unblock never restores. */
export async function invalidateBlockedVoicePair(tx: Tx, first: string, second: string) {
  await lockVoice(tx);
  const rows = await selectedVoiceMembers(tx, { userId: first });
  for (const callId of [...new Set(rows.map(r => r.call.id))]) {
    const peers = await liveMembers(tx, callId);
    if (peers.some(m => m.userId === second)) await invalidateVoiceMembership(tx, { callId }, "blocked-pair");
  }
}
async function closeEmptyVoiceCall(tx: Tx, call: Call, now: Date) {
  if (call.status !== "active" || (await liveMembers(tx, call.id)).length) return;
  await tx.update(voiceCall).set({ status: "closed", closedAt: now }).where(eq(voiceCall.id, call.id));
  await tx.delete(voiceControlMailbox).where(eq(voiceControlMailbox.callId, call.id));
  const ids = (await tx.select({ id: voiceCallMember.id }).from(voiceCallMember).where(eq(voiceCallMember.callId, call.id))).map(m => m.id);
  if (ids.length) {
    await tx.delete(voiceControlReceipt).where(inArray(voiceControlReceipt.senderMemberId, ids));
    await tx.delete(voicePrekey).where(inArray(voicePrekey.memberId, ids));
    await tx.delete(voiceSignature).where(or(inArray(voiceSignature.signerMemberId, ids), inArray(voiceSignature.targetMemberId, ids)));
    await tx.delete(voiceIdentity).where(inArray(voiceIdentity.memberId, ids));
  }
  call.status = "closed"; call.closedAt = now;
}
// Filter before LIMIT: healthy calls never occupy the bounded repair population.
const voiceRepairEligible = (now: Date) => sql`(
  not exists (select 1 from public.voice_call_member m where m.call_id = ${voiceCall.id} and m.state <> 'left')
  or exists (
    select 1 from public.voice_call_member m
    left join public.session s on s.id = m.session_id
    left join public.dm_device d on d.id = m.anchor_device_id
    where m.call_id = ${voiceCall.id} and m.state <> 'left'
      and (m.lease_expires_at <= ${now} or s.id is null or s.expires_at <= ${now} or d.id is null or d.revoked_at is not null)
  )
)`;
/** Separate DB-only Voice batches; eligibility and keyset prevent healthy-prefix starvation. */
export async function sweepVoiceLifecycle({ apply, now, batchSize, maxBatches }: { apply: boolean; now: Date; batchSize: number; maxBatches: number }) {
  if (!apply) return { scanned: await db.$count(voiceCall, and(eq(voiceCall.status, "active"), voiceRepairEligible(now))), closed: 0, removed: 0, limited: false };
  let cursor: string | undefined, scanned = 0, closed = 0, removed = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await db.transaction(async tx => {
      await lockVoice(tx);
      const calls = await tx.select({ call: voiceCall, communityId: channel.communityId }).from(voiceCall).innerJoin(channel, eq(channel.id, voiceCall.channelId))
        .where(and(eq(voiceCall.status, "active"), voiceRepairEligible(now), cursor ? gt(voiceCall.id, cursor) : undefined)).orderBy(asc(voiceCall.id)).limit(batchSize);
      for (const id of [...new Set(calls.map(c => c.communityId))].sort()) await lockCommunity(tx, id);
      let closed = 0, removed = 0;
      for (const row of calls) {
        const [call] = await tx.select().from(voiceCall).where(eq(voiceCall.id, row.call.id)).for("update");
        if (call.status !== "active") continue;
        removed += (await expireAndRevalidate(tx, call, now)).length;
        if (call.status === "closed") closed++;
      }
      return { calls, closed, removed };
    });
    scanned += result.calls.length; closed += result.closed; removed += result.removed;
    cursor = result.calls.at(-1)?.call.id;
    if (result.calls.length < batchSize) return { scanned, closed, removed, limited: false };
  }
  return { scanned, closed, removed, limited: true };
}

const keyRecord = z.record(z.string().regex(/^signed_curve25519:[A-Za-z0-9+/_=-]{1,100}$/), voicePrekeySchema);
const uploadBody = z.object({ device_keys: voiceDeviceKeysSchema.optional(), one_time_keys: keyRecord.optional(), fallback_keys: keyRecord.optional() }).strict();
const crossKey = voiceSignedObjectSchema.extend({ usage: z.array(z.enum(["master", "self_signing", "user_signing"])).length(1) });
const signingBody = z.object({ master_key: crossKey, self_signing_key: crossKey, user_signing_key: crossKey }).strict();
const queryBody = z.object({ device_keys: z.record(z.string().max(256), z.array(z.uuid()).max(1)), timeout: z.number().int().min(0).max(60_000).optional(), token: z.string().max(128).optional() }).strict();
const claimBody = z.object({ one_time_keys: z.record(z.string().max(256), z.record(z.uuid(), z.literal("signed_curve25519"))), timeout: z.number().int().min(0).max(60_000).optional() }).strict();
const sendBody = z.object({ messages: z.record(z.string().max(256), z.record(z.uuid(), object)) }).strict();

async function targetFor(tx: Tx, callId: string, userId: string): Promise<Member> {
  const [target] = await tx.select().from(voiceCallMember).where(and(eq(voiceCallMember.callId, callId), eq(voiceCallMember.voiceUserId, userId), ne(voiceCallMember.state, "left")));
  if (!target) throw notFound("Current voice device not found.");
  return target;
}
function selfSignatures(value: { signatures?: Record<string, Record<string, string>> }, ownUser: string) {
  if (value.signatures && Object.keys(value.signatures).some((id) => id !== ownUser)) throw invalid("Only this voice identity may sign its uploaded keys.");
}
async function identityFor(tx: Tx, memberId: string) {
  const [identity] = await tx.select().from(voiceIdentity).where(eq(voiceIdentity.memberId, memberId));
  return identity;
}
async function storeReceipt(tx: Tx, own: Member, requestId: string, requestDigest: string, response: Json, now: Date) {
  if (await tx.$count(voiceControlReceipt, eq(voiceControlReceipt.senderMemberId, own.id)) >= L.receipts) throw invalid("Voice request lifetime limit reached. Rejoin with a fresh identity.");
  await tx.insert(voiceControlReceipt).values({ senderMemberId: own.id, requestId, digest: requestDigest, response, expiresAt: new Date(now.getTime() + L.receiptTtlMs) });
}
function signingId(key: unknown): string {
  const values = Object.values(record(record(key).keys));
  if (values.length !== 1 || typeof values[0] !== "string") throw invalid("Invalid native signing key.");
  return values[0];
}
function withoutSignatures(value: Json): Json {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== "signatures"));
}

/** Supported public native wire requests only. Opaque Olm content stays opaque; this service
 * does not certify SAS, audience admission, media-key readiness or native decoder readiness. */
export async function handleVoiceCrypto(rawAuth: unknown, input: unknown): Promise<Json> {
  const auth = parse(voiceMemberAuthSchema, rawAuth), data = parse(voiceCryptoInputSchema, input), request = data.request;
  const limit = request.kind === "upload" || request.kind === "signing" ? L.bootstrapBytes : L.requestBytes;
  if (Buffer.byteLength(JSON.stringify(request)) > limit) throw invalid("Voice crypto request exceeds the size limit.");
  // Validate bounded native body work before acquiring the shared voice lock.
  let body: Json = {};
  if (request.kind === "upload") {
    body = parse(uploadBody, request.body);
    if (Object.keys(record(body.one_time_keys ?? {})).length > L.prekeys || Object.keys(record(body.fallback_keys ?? {})).length > 1) throw invalid("Too many native prekeys.");
  } else if (request.kind === "signing") body = parse(signingBody, request.body);
  else if (request.kind === "query") body = parse(queryBody, request.body);
  else if (request.kind === "claim") body = parse(claimBody, request.body);
  else if (request.kind === "send") {
    body = parse(sendBody, request.body);
    if (!voiceEventSchema(request.eventType)) throw invalid("Unsupported voice device event.");
  } else if (request.kind === "signatures") body = request.body;
  const nested = request.kind === "query" ? body.device_keys : request.kind === "claim" ? body.one_time_keys : request.kind === "send" ? body.messages : request.kind === "signatures" ? body : undefined;
  if (nested !== undefined) {
    const entries = Object.entries(record(nested));
    if (entries.length > (request.kind === "send" ? L.members - 1 : L.members)) throw invalid("Too many voice targets.");
    let work = 0;
    for (const [, value] of entries) {
      const count = Array.isArray(value) ? value.length : Object.keys(record(value)).length;
      if (count > (request.kind === "signatures" ? 2 : 1) || (work += Math.max(count, 1)) > (request.kind === "signatures" ? 16 : L.members)) throw invalid("Too many voice target keys.");
    }
  }
  await consume(`voice-control:${auth.userId}`, 240, 60_000);
  const result = await db.transaction(async (tx): Promise<Json | AppError> => {
    const access = await boundAccess(tx, auth, data);
    if (access instanceof AppError) return access;
    const { call, own, now } = access;
    if (call.generation !== data.expectedGeneration) return conflict("Voice membership changed. Refresh the current roster.");
    await tx.delete(voiceControlMailbox).where(and(eq(voiceControlMailbox.callId, call.id), lte(voiceControlMailbox.expiresAt, now)));
    // Crucially validate current scope BEFORE receipt replay, so an old receipt never reveals a
    // removed device. Active-member receipts are tombstones, never purged by TTL or rekey.
    if (nested !== undefined) {
      for (const [matrixId, devices] of Object.entries(record(nested))) {
        const target = await targetFor(tx, call.id, matrixId);
        if (request.kind !== "signatures") {
          const ids = Array.isArray(devices) ? devices : Object.keys(record(devices));
          if (ids.some((id) => id !== target.voiceDeviceId)) throw notFound("Current voice device not found.");
        }
        if (request.kind === "send" && target.id === own.id) throw invalid("Voice device events must target another current member.");
      }
    }
    if (request.kind === "sync") {
      const events = await tx.select().from(voiceControlMailbox).where(and(eq(voiceControlMailbox.recipientMemberId, own.id), eq(voiceControlMailbox.generation, call.generation), gt(voiceControlMailbox.expiresAt, now))).orderBy(asc(voiceControlMailbox.id)).limit(L.syncBatch);
      const cursor = events.at(-1)?.id ?? own.deliveredCursor;
      if (cursor > own.deliveredCursor) await tx.update(voiceCallMember).set({ deliveredCursor: cursor }).where(eq(voiceCallMember.id, own.id));
      const keys = await tx.select().from(voicePrekey).where(and(eq(voicePrekey.memberId, own.id), eq(voicePrekey.retired, false), or(eq(voicePrekey.fallback, true), eq(voicePrekey.used, false))));
      return { cursor: String(cursor), events: events.map((e) => e.event), oneTimeKeys: { signed_curve25519: keys.filter((k) => !k.fallback && !k.used).length }, unusedFallbackKeys: keys.some((k) => k.fallback && !k.used) ? ["signed_curve25519"] : [] };
    }
    if (request.kind === "ack") {
      const cursor = Number(request.cursor);
      if (cursor > own.deliveredCursor) throw invalid("Acknowledge only an already delivered voice cursor.");
      await tx.delete(voiceControlMailbox).where(and(eq(voiceControlMailbox.recipientMemberId, own.id), lte(voiceControlMailbox.id, cursor)));
      return {};
    }
    const requestDigest = digest(canonical({ callId: call.id, memberId: own.id, generation: call.generation, request }));
    const requestId = "requestId" in request && request.requestId ? request.requestId : `${request.kind}:${requestDigest}`;
    // Queries read mutable public key/signature state; they must never replay a cached response.
    const [receipt] = request.kind === "query" ? [] : await tx.select().from(voiceControlReceipt).where(and(eq(voiceControlReceipt.senderMemberId, own.id), eq(voiceControlReceipt.requestId, requestId)));
    if (receipt) {
      if (receipt.digest !== requestDigest) throw conflict("A voice transaction ID cannot be reused for different work.");
      if (receipt.expiresAt <= now) throw conflict("This voice transaction retry window has ended. Rejoin if native work cannot continue.");
      return receipt.response;
    }
    let response: Json = {};
    if (request.kind === "upload") {
      const identity = await identityFor(tx, own.id);
      let deviceKeys = identity?.deviceKeys ?? null;
      if (body.device_keys) {
        const keys = parse(voiceDeviceKeysSchema, body.device_keys);
        const expectedIds = [`curve25519:${own.voiceDeviceId}`, `ed25519:${own.voiceDeviceId}`];
        if (keys.user_id !== own.voiceUserId || keys.device_id !== own.voiceDeviceId || Object.keys(keys.keys).length !== 2 || expectedIds.some((id) => !keys.keys[id]) || new Set(keys.algorithms).size !== 2) throw invalid("Native device keys do not match this voice enrollment.");
        selfSignatures(keys, own.voiceUserId);
        if (deviceKeys && !same(deviceKeys, keys)) throw conflict("Native voice device keys are immutable.");
        deviceKeys = keys;
        await tx.insert(voiceIdentity).values({ memberId: own.id, deviceKeys }).onConflictDoUpdate({ target: voiceIdentity.memberId, set: { deviceKeys } });
      }
      if (!deviceKeys) throw invalid("Upload this voice device's native identity first.");
      for (const fallback of [false, true]) {
        for (const [keyId, raw] of Object.entries(record(body[fallback ? "fallback_keys" : "one_time_keys"] ?? {}))) {
          const content = parse(voicePrekeySchema, raw);
          selfSignatures(content, own.voiceUserId);
          if (!!content.fallback !== fallback) throw invalid("Native fallback key flag mismatch.");
          const [existing] = await tx.select().from(voicePrekey).where(and(eq(voicePrekey.memberId, own.id), eq(voicePrekey.keyId, keyId), eq(voicePrekey.fallback, fallback)));
          if (existing && !same(existing.content, content)) throw conflict("Native voice prekeys are immutable.");
          if (!existing) {
            if (await tx.$count(voicePrekey, eq(voicePrekey.memberId, own.id)) >= L.lifetimePrekeys) throw invalid("Native voice prekey lifetime limit reached.");
            if (fallback) await tx.update(voicePrekey).set({ retired: true }).where(and(eq(voicePrekey.memberId, own.id), eq(voicePrekey.fallback, true)));
            await tx.insert(voicePrekey).values({ memberId: own.id, keyId, fallback, content });
          }
        }
      }
      const total = await tx.$count(voicePrekey, and(eq(voicePrekey.memberId, own.id), eq(voicePrekey.fallback, false), eq(voicePrekey.used, false)));
      if (total > L.prekeys) throw invalid("Too many available native voice prekeys.");
      await tx.update(voiceCallMember).set({ state: "active" }).where(eq(voiceCallMember.id, own.id));
      response = { one_time_key_counts: { signed_curve25519: total } };
    } else if (request.kind === "signing") {
      const keys = parse(signingBody, body);
      for (const [name, key] of Object.entries(keys)) {
        if (key.user_id !== own.voiceUserId || key.usage[0] !== name.replace(/_key$/, "") || Object.keys(key.keys).length !== 1 || Object.keys(key.keys)[0] !== `ed25519:${signingId(key)}`) throw invalid("Native signing keys do not match this voice identity.");
        selfSignatures(key, own.voiceUserId);
      }
      const identity = await identityFor(tx, own.id);
      if (identity?.crossSigningKeys && !same(identity.crossSigningKeys, keys)) throw conflict("Native voice signing keys are immutable.");
      await tx.insert(voiceIdentity).values({ memberId: own.id, crossSigningKeys: keys }).onConflictDoUpdate({ target: voiceIdentity.memberId, set: { crossSigningKeys: keys } });
    } else if (request.kind === "query") {
      const device_keys: Json = {}, master_keys: Json = {}, self_signing_keys: Json = {}, user_signing_keys: Json = {};
      for (const matrixId of Object.keys(record(body.device_keys))) {
        const target = await targetFor(tx, call.id, matrixId), identity = await identityFor(tx, target.id);
        const signatures = await tx.select().from(voiceSignature).where(and(eq(voiceSignature.targetMemberId, target.id), or(eq(voiceSignature.signerMemberId, target.id), eq(voiceSignature.signerMemberId, own.id))));
        const attach = (keyId: string, value: Json): Json => {
          const merged = record(value.signatures ?? {});
          for (const signature of signatures.filter((s) => s.keyId === keyId)) {
            const signer = signature.signerMemberId === own.id ? own.voiceUserId : target.voiceUserId;
            merged[signer] = { ...record(merged[signer] ?? {}), ...signature.signatures };
          }
          return { ...value, signatures: Object.fromEntries(Object.entries(merged).filter(([signer]) => signer === target.voiceUserId || signer === own.voiceUserId)) };
        };
        device_keys[matrixId] = identity?.deviceKeys ? { [target.voiceDeviceId]: attach(target.voiceDeviceId, identity.deviceKeys) } : {};
        if (identity?.crossSigningKeys) {
          const cross = identity.crossSigningKeys;
          master_keys[matrixId] = attach(signingId(cross.master_key), record(cross.master_key));
          self_signing_keys[matrixId] = attach("", record(cross.self_signing_key));
          if (own.id === target.id) user_signing_keys[matrixId] = attach("", record(cross.user_signing_key));
        }
      }
      response = { device_keys, master_keys, self_signing_keys, user_signing_keys, failures: {} };
    } else if (request.kind === "signatures") {
      const identity = await identityFor(tx, own.id);
      const signerIds = new Set([`ed25519:${own.voiceDeviceId}`, ...Object.values(identity?.crossSigningKeys ?? {}).flatMap((key) => Object.keys(record(record(key).keys)))]);
      for (const [matrixId, rawKeys] of Object.entries(body)) {
        const target = await targetFor(tx, call.id, matrixId), targetIdentity = await identityFor(tx, target.id);
        for (const [keyId, raw] of Object.entries(record(rawKeys))) {
          const original = keyId === target.voiceDeviceId ? targetIdentity?.deviceKeys : targetIdentity?.crossSigningKeys && signingId(targetIdentity.crossSigningKeys.master_key) === keyId ? record(targetIdentity.crossSigningKeys.master_key) : undefined;
          if (!original) throw invalid("Native signature target does not exist.");
          const item = keyId === target.voiceDeviceId ? parse(voiceDeviceKeysSchema, raw) : parse(crossKey, raw);
          if (!same(withoutSignatures(item), withoutSignatures(original))) throw invalid("Native signature target mismatch.");
          const signatures = item.signatures?.[own.voiceUserId];
          if (!signatures || !Object.keys(signatures).length || Object.keys(signatures).some((id) => !signerIds.has(id))) throw invalid("Missing or foreign native voice signature.");
          await tx.insert(voiceSignature).values({ signerMemberId: own.id, targetMemberId: target.id, keyId, signatures }).onConflictDoUpdate({ target: [voiceSignature.signerMemberId, voiceSignature.targetMemberId, voiceSignature.keyId], set: { signatures } });
        }
      }
      response = { failures: {} };
    } else if (request.kind === "claim") {
      const one_time_keys: Json = {};
      for (const matrixId of Object.keys(record(body.one_time_keys))) {
        const target = await targetFor(tx, call.id, matrixId);
        const responseKeys: Json = {};
        for (const deviceId of Object.keys(record(record(body.one_time_keys)[matrixId]))) {
          const [key] = await tx.select().from(voicePrekey).where(and(eq(voicePrekey.memberId, target.id), eq(voicePrekey.retired, false), or(eq(voicePrekey.used, false), eq(voicePrekey.fallback, true)))).orderBy(asc(voicePrekey.fallback), asc(voicePrekey.keyId)).limit(1).for("update");
          if (key) {
            responseKeys[deviceId] = { [key.keyId]: key.content };
            await tx.update(voicePrekey).set({ used: true }).where(and(eq(voicePrekey.memberId, target.id), eq(voicePrekey.keyId, key.keyId), eq(voicePrekey.fallback, key.fallback)));
          }
        }
        one_time_keys[matrixId] = responseKeys;
      }
      response = { one_time_keys, failures: {} };
    } else if (request.kind === "send") {
      const identity = await identityFor(tx, own.id);
      if (!identity?.deviceKeys) throw invalid("Upload this voice device's native identity first.");
      for (const [matrixId, rawDevices] of Object.entries(record(body.messages))) {
        const target = await targetFor(tx, call.id, matrixId);
        for (const rawContent of Object.values(record(rawDevices))) {
          const schema = voiceEventSchema(request.eventType);
          if (!schema) throw invalid("Unsupported voice device event.");
          const content = record(parse(schema, rawContent));
          if (request.eventType === "m.room.encrypted") {
            const targetIdentity = await identityFor(tx, target.id);
            const targetKey = record(targetIdentity?.deviceKeys?.keys ?? {})[`curve25519:${target.voiceDeviceId}`];
            if (content.sender_key !== record(identity.deviceKeys.keys)[`curve25519:${own.voiceDeviceId}`] || typeof targetKey !== "string" || Object.keys(record(content.ciphertext)).length !== 1 || !Object.hasOwn(record(content.ciphertext), targetKey)) throw invalid("Native Olm envelope does not match current voice devices.");
          } else if (content.from_device !== undefined && content.from_device !== own.voiceDeviceId) throw invalid("Native verification sender mismatch.");
          if (await tx.$count(voiceControlMailbox, eq(voiceControlMailbox.recipientMemberId, target.id)) >= L.mailbox) throw invalid("This voice device mailbox is full.");
          await tx.insert(voiceControlMailbox).values({ callId: call.id, senderMemberId: own.id, recipientMemberId: target.id, generation: call.generation, event: { sender: own.voiceUserId, type: request.eventType, content }, expiresAt: new Date(now.getTime() + L.mailboxTtlMs) });
        }
      }
    }
    if (request.kind !== "query") await storeReceipt(tx, own, requestId, requestDigest, response, now);
    return response;
  });
  if (result instanceof AppError) throw result;
  return result;
}
