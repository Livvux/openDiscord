import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { channel, member, role, session } from "@/db/schema";
import { voiceCall, voiceCallMember } from "@/db/voice-schema";
import { createCommunity, leaveCommunity, setChannelOverride } from "@/server/communities";
import { registerDmDevice, revokeDmDevice } from "@/server/direct-messages";
import { heartbeatVoiceControl, joinVoiceControl } from "@/server/voice-control";
import { blockUser, unblockUser } from "@/server/blocks";
import { Permission } from "@/server/permissions";
import { runMaintenance } from "@/server/maintenance";
import { testUsers } from "./helpers";

const users = testUsers();
afterAll(() => users.cleanup());
async function fixture() {
  const userId = await users.create("Voice lifecycle cascade");
  const sessionId = randomUUID(), anchorDeviceId = randomUUID(), anchorSecret = randomBytes(32).toString("hex");
  await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Lifecycle anchor" });
  const c = await createCommunity(userId, "Voice lifecycle");
  const [ch] = await db.insert(channel).values({ communityId: c.communityId, name: "lifecycle", kind: "voice" }).returning();
  const snapshot = await joinVoiceControl({ userId, sessionId, anchorDeviceId, anchorSecret }, { channelId: ch.id, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: randomBytes(32).toString("hex"), consent: true });
  return { userId, communityId: c.communityId, channelId: ch.id, sessionId, anchorDeviceId, snapshot };
}

describe("unreleased native Voice lifecycle backstop", () => {
  it("advances surviving call generation in the same transaction as native session cascade", async () => {
    const { sessionId, snapshot } = await fixture();
    await db.delete(session).where(eq(session.id, sessionId));
    expect(await db.$count(voiceCallMember, eq(voiceCallMember.id, snapshot.memberId))).toBe(0);
    const [call] = await db.select().from(voiceCall).where(eq(voiceCall.id, snapshot.callId));
    expect(call.generation).toBe(snapshot.generation + 1);
  });
  it("rolls back both session cascade and generation when the native transaction aborts", async () => {
    const { sessionId, snapshot } = await fixture();
    const aborted = new Error("deliberate lifecycle rollback");
    await expect(db.transaction(async (tx) => {
      await tx.delete(session).where(eq(session.id, sessionId));
      const [call] = await tx.select().from(voiceCall).where(eq(voiceCall.id, snapshot.callId));
      expect(call.generation).toBe(snapshot.generation + 1);
      throw aborted;
    })).rejects.toBe(aborted);
    expect(await db.$count(voiceCallMember, eq(voiceCallMember.id, snapshot.memberId))).toBe(1);
    const [call] = await db.select().from(voiceCall).where(eq(voiceCall.id, snapshot.callId));
    expect(call.generation).toBe(snapshot.generation);
  });
});

async function peer(f: Awaited<ReturnType<typeof fixture>>) {
  const userId = await users.create("Voice lifecycle peer"), sessionId = randomUUID(), anchorDeviceId = randomUUID(), anchorSecret = randomBytes(32).toString("hex"), secret = randomBytes(32).toString("hex");
  await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Peer anchor" });
  await db.insert(member).values({ communityId: f.communityId, userId });
  const snapshot = await joinVoiceControl({ userId, sessionId, anchorDeviceId, anchorSecret }, { channelId: f.channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: secret, consent: true });
  return { userId, sessionId, anchorDeviceId, secret, snapshot };
}
async function state(id: string) { const [m] = await db.select().from(voiceCallMember).where(eq(voiceCallMember.id, id)); return m?.state; }
describe("atomic product mutation invalidation", () => {
  it("ends only the departing member's enrollment and does not revive it on rejoin", async () => {
    const f = await fixture(), p = await peer(f);
    await leaveCommunity(p.userId, f.communityId);
    expect(await state(p.snapshot.memberId)).toBe("left");
    expect(await state(f.snapshot.memberId)).toBe("waiting");
    await db.insert(member).values({ communityId: f.communityId, userId: p.userId });
    expect(await state(p.snapshot.memberId)).toBe("left");
  });
  it("terminally invalidates source capability loss while capability additions preserve enrollment", async () => {
    const f = await fixture(), p = await peer(f);
    const [everyone] = await db.select().from(role).where(and(eq(role.communityId, f.communityId), eq(role.isDefault, true)));
    await setChannelOverride(f.userId, f.channelId, everyone.id, Permission.Video, 0);
    expect(await state(p.snapshot.memberId)).toBe("waiting");
    await setChannelOverride(f.userId, f.channelId, everyone.id, 0, Permission.Speak);
    expect(await state(p.snapshot.memberId)).toBe("left");
    expect(await state(f.snapshot.memberId)).toBe("waiting");
    await setChannelOverride(f.userId, f.channelId, everyone.id, 0, 0);
    expect(await state(p.snapshot.memberId)).toBe("left");
  });
  it("closes only calls containing both blocked accounts and unblock cannot revive them", async () => {
    const f = await fixture(), p = await peer(f), unrelated = await fixture();
    await blockUser(f.userId, p.userId);
    const [call] = await db.select().from(voiceCall).where(eq(voiceCall.id, f.snapshot.callId));
    expect(call.status).toBe("closed");
    expect(await state(f.snapshot.memberId)).toBe("left");
    expect(await state(p.snapshot.memberId)).toBe("left");
    expect(await state(unrelated.snapshot.memberId)).toBe("waiting");
    await unblockUser(f.userId, p.userId);
    expect(await state(p.snapshot.memberId)).toBe("left");
  });
  it("invalidates an exact revoked anchor before revoke commits", async () => {
    const f = await fixture(), p = await peer(f);
    await revokeDmDevice(p.userId, p.anchorDeviceId);
    expect(await state(p.snapshot.memberId)).toBe("left");
    expect(await state(f.snapshot.memberId)).toBe("waiting");
  });
  it("healthy peer polling commits expiry reaping and rejects stale generation", async () => {
    const f = await fixture(), p = await peer(f);
    await db.update(session).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(session.id, f.sessionId));
    const current = await heartbeatVoiceControl({ userId: p.userId, sessionId: p.sessionId, memberId: p.snapshot.memberId, secret: p.secret }, { callId: p.snapshot.callId, memberId: p.snapshot.memberId, joinNonce: p.snapshot.joinNonce, expectedGeneration: p.snapshot.generation });
    expect(await state(f.snapshot.memberId)).toBe("left");
    expect(current.generation).toBeGreaterThan(p.snapshot.generation);
    expect(current.members.map(m => m.memberId)).toEqual([p.snapshot.memberId]);
  });
  it("maintenance dry run is read-only and apply closes native-cascade empty calls", async () => {
    const f = await fixture();
    await db.delete(session).where(eq(session.id, f.sessionId));
    await runMaintenance({ apply: false, batchSize: 1, maxBatches: 100 });
    const [before] = await db.select().from(voiceCall).where(eq(voiceCall.id, f.snapshot.callId));
    expect(before.status).toBe("active");
    await runMaintenance({ apply: true, batchSize: 1, maxBatches: 100 });
    const [after] = await db.select().from(voiceCall).where(eq(voiceCall.id, f.snapshot.callId));
    expect(after.status).toBe("closed");
  });
});
