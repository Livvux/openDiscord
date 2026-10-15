import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AccessToken, Room, RoomServiceClient, ServerError } from "livekit-server-sdk";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { channel, session, member } from "@/db/schema";
import { voiceCall, voiceSfuRoom, voiceCallMember, voiceIdentity } from "@/db/voice-schema";
import { consumeVoiceRooms, retireOwnedVoiceRoom, voiceTransaction } from "@/server/voice-sfu";
import { createCommunity, deleteChannel } from "@/server/communities";
import { registerDmDevice } from "@/server/direct-messages";
import { joinVoiceControl, grantBoundVoiceMedia, handleVoiceCrypto, heartbeatVoiceControl, leaveVoiceControl } from "@/server/voice-control";
import { createBoundVoiceToken } from "@/server/voice";
import { testUsers } from "./helpers";

beforeEach(() => {
  vi.spyOn(RoomServiceClient.prototype, "createRoom").mockImplementation(async options => new Room({ name: options.name }));
  vi.spyOn(RoomServiceClient.prototype, "listParticipants").mockResolvedValue([]);
  vi.spyOn(RoomServiceClient.prototype, "deleteRoom").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());
const users = testUsers();
afterAll(() => users.cleanup());
async function fixture() {
  const userId = await users.create("Bound grant"), sessionId = randomUUID(), anchorDeviceId = randomUUID(), anchorSecret = randomBytes(32).toString("hex"), secret = randomBytes(32).toString("hex");
  await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) });
  await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Grant anchor" });
  const c = await createCommunity(userId, "Grant fixture");
  const [ch] = await db.insert(channel).values({ communityId: c.communityId, name: "voice", kind: "voice" }).returning();
  const snapshot = await joinVoiceControl({ userId, sessionId, anchorDeviceId, anchorSecret }, { channelId: ch.id, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: secret, consent: true });
  return { userId, communityId: c.communityId, sessionId, anchorDeviceId, secret, snapshot,
    auth: { userId, sessionId, memberId: snapshot.memberId, secret }, binding: { callId: snapshot.callId, memberId: snapshot.memberId, joinNonce: snapshot.joinNonce, expectedGeneration: snapshot.generation } };
}

describe("generation room ownership", () => {
  it("does not sign a capability when explicit owned SFU creation fails", async () => {
    const f = await fixture();
    const create = vi.spyOn(RoomServiceClient.prototype, "createRoom").mockRejectedValue(new Error("SFU unavailable"));
    const sign = vi.spyOn(AccessToken.prototype, "toJwt");
    try {
      await expect(createBoundVoiceToken(f.auth, f.binding)).rejects.toMatchObject({ code: "conflict" });
      expect(create).toHaveBeenCalledWith({ name: `voice:${f.snapshot.channelId}:${f.snapshot.callId}:${f.snapshot.generation}` });
      expect(sign).not.toHaveBeenCalled();
    } finally { create.mockRestore(); sign.mockRestore(); }
  });
});

const owned = async (name: string) => (await db.select().from(voiceSfuRoom).where(eq(voiceSfuRoom.roomName, name)))[0];
const due = async (name: string) => db.update(voiceSfuRoom).set({ nextAttemptAt: new Date(0), leaseToken: null, leaseUntil: null }).where(eq(voiceSfuRoom.roomName, name));

async function peer(f: Awaited<ReturnType<typeof fixture>>) {
  const userId = await users.create("Room peer"), sessionId = randomUUID(), anchorDeviceId = randomUUID(), anchorSecret = randomBytes(32).toString("hex"), secret = randomBytes(32).toString("hex");
  await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) });
  await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Peer" });
  await db.insert(member).values({ userId, communityId: f.communityId });
  const snapshot = await joinVoiceControl({ userId, sessionId, anchorDeviceId, anchorSecret }, { channelId: f.snapshot.channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: secret, consent: true });
  return { auth: { userId, sessionId, memberId: snapshot.memberId, secret }, binding: { callId: snapshot.callId, memberId: snapshot.memberId, joinNonce: snapshot.joinNonce, expectedGeneration: snapshot.generation }, snapshot };
}

describe("durable room lifecycle", () => {
  it("commits ownership before SDK creation, revalidates after creation, and bounds actual JWT expiry by the reservation", async () => {
    const f = await fixture();
    expect(await db.$count(voiceSfuRoom, eq(voiceSfuRoom.callId, f.snapshot.callId))).toBe(0);
    let createdName = "";
    vi.mocked(RoomServiceClient.prototype.createRoom).mockImplementation(async options => {
      createdName = options.name;
      expect((await owned(options.name)).status).toBe("active");
      const { rows } = await db.execute<{ free: boolean }>(sql`select pg_try_advisory_xact_lock(810030) as free`);
      expect(rows[0].free).toBe(true);
      return new Room({ name: options.name });
    });
    const result = await createBoundVoiceToken(f.auth, f.binding), reservation = await owned(createdName);
    const claims = JSON.parse(Buffer.from(result.token.split(".")[1], "base64url").toString());
    expect(claims.exp * 1000).toBeLessThanOrEqual(reservation.lastAppTokenExpiry.getTime());
    expect(claims.video.roomCreate).toBeUndefined();
    expect(claims.video.roomAdmin).toBeUndefined();
    expect(claims.video.room).toBe(createdName);
  });

  it("never signs a stale JWT when call retirement commits during createRoom", async () => {
    const f = await fixture();
    vi.mocked(RoomServiceClient.prototype.createRoom).mockImplementation(async options => {
      await leaveVoiceControl(f.auth, f.binding);
      return new Room({ name: options.name });
    });
    const sign = vi.spyOn(AccessToken.prototype, "toJwt");
    await expect(createBoundVoiceToken(f.auth, f.binding)).rejects.toMatchObject({ code: "forbidden" });
    expect(sign).not.toHaveBeenCalled();
    const [row] = await db.select().from(voiceSfuRoom).where(eq(voiceSfuRoom.callId, f.snapshot.callId));
    expect(row.status).toBe("retired");
  });

  it("retires the old room on JOIN with zero synthetic member removals", async () => {
    const f = await fixture(), grant = await grantBoundVoiceMedia(f.auth, f.binding);
    const p = await peer(f);
    expect(p.snapshot.removals).toEqual([]);
    expect(p.snapshot.generation).toBe(f.snapshot.generation + 1);
    expect((await owned(grant.roomName)).status).toBe("retired");
    expect(RoomServiceClient.prototype.deleteRoom).toHaveBeenCalledWith(grant.roomName);
    expect(await db.$count(voiceSfuRoom, eq(voiceSfuRoom.callId, f.snapshot.callId))).toBe(1);
  });

  it("rolls back generation retirement and dispatches zero SDK effects on transaction failure", async () => {
    const f = await fixture(), grant = await grantBoundVoiceMedia(f.auth, f.binding);
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockClear();
    await expect(voiceTransaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(810030)`);
      await tx.update(voiceCall).set({ generation: f.snapshot.generation + 1 }).where(eq(voiceCall.id, f.snapshot.callId));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await owned(grant.roomName)).status).toBe("active");
    expect(RoomServiceClient.prototype.deleteRoom).not.toHaveBeenCalled();
  });

  it("retains exact ownership after parent cascade and does not touch another room", async () => {
    const f = await fixture(), grant = await grantBoundVoiceMedia(f.auth, f.binding);
    const foreign = await fixture(), other = await grantBoundVoiceMedia(foreign.auth, foreign.binding);
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockClear();
    await deleteChannel(f.userId, f.snapshot.channelId);
    expect((await owned(grant.roomName)).status).toBe("retired");
    expect((await owned(other.roomName)).status).toBe("active");
    expect(RoomServiceClient.prototype.deleteRoom).toHaveBeenCalledWith(grant.roomName);
    expect(RoomServiceClient.prototype.deleteRoom).not.toHaveBeenCalledWith(other.roomName);
  });

  it("native session cascade retires the issued generation atomically without a callback", async () => {
    const f = await fixture(), grant = await grantBoundVoiceMedia(f.auth, f.binding);
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockClear();
    await db.delete(session).where(eq(session.id, f.sessionId));
    expect((await owned(grant.roomName)).status).toBe("retired");
    expect(RoomServiceClient.prototype.deleteRoom).not.toHaveBeenCalled();
    await due(grant.roomName);
    await consumeVoiceRooms({ maxRooms: 1 });
    expect(RoomServiceClient.prototype.deleteRoom).toHaveBeenCalledWith(grant.roomName);
  });

  it("commits expiry reaping but rolls back partial crypto upload writes on AppError", async () => {
    const f = await fixture(), p = await peer(f);
    const binding = { ...f.binding, expectedGeneration: p.snapshot.generation };
    const grant = await grantBoundVoiceMedia(f.auth, binding);
    await db.update(voiceCallMember).set({ leaseExpiresAt: new Date(0) }).where(eq(voiceCallMember.id, p.snapshot.memberId));
    // Reaping changes generation, so first obtain its committed authoritative roster.
    const current = await heartbeatVoiceControl(f.auth, binding);
    const keys = { user_id: f.snapshot.voiceUserId, device_id: f.snapshot.voiceDeviceId, algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"], keys: { [`curve25519:${f.snapshot.voiceDeviceId}`]: "curve", [`ed25519:${f.snapshot.voiceDeviceId}`]: "ed" } };
    await expect(handleVoiceCrypto(f.auth, { ...binding, expectedGeneration: current.generation, request: { kind: "upload", body: { device_keys: keys, one_time_keys: { "signed_curve25519:bad": { key: "key", signatures: { foreign: { sig: "bad" } } } } } } })).rejects.toMatchObject({ code: "invalid" });
    expect(await db.$count(voiceIdentity, eq(voiceIdentity.memberId, f.snapshot.memberId))).toBe(0);
    expect((await owned(grant.roomName)).status).toBe("retired");
  });

  it("retired status is terminal and refreshed-token horizons never trigger tombstone deletion", async () => {
    const f = await fixture(), grant = await grantBoundVoiceMedia(f.auth, f.binding);
    await retireOwnedVoiceRoom(grant.roomName);
    await db.update(voiceSfuRoom).set({ lastAppTokenExpiry: new Date(0) }).where(eq(voiceSfuRoom.roomName, grant.roomName));
    await expect(grantBoundVoiceMedia(f.auth, f.binding)).rejects.toMatchObject({ code: "forbidden" });
    await expect(db.update(voiceSfuRoom).set({ status: "active", retiredAt: null }).where(eq(voiceSfuRoom.roomName, grant.roomName))).rejects.toThrow();
    await due(grant.roomName);
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockRejectedValue(new ServerError("not_found", "private details", 404, "not_found"));
    await consumeVoiceRooms({ maxRooms: 1 });
    expect(await owned(grant.roomName)).toMatchObject({ status: "retired", lastOutcome: "not_found" });
    expect((await owned(grant.roomName)).nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});
