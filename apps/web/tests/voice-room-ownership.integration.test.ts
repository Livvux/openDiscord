import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AccessToken, ParticipantInfo, ParticipantPermission, Room, RoomServiceClient, ServerError, TrackSource } from "livekit-server-sdk";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelOverride, role, session, member } from "@/db/schema";
import { voiceCall, voiceSfuRoom, voiceCallMember, voiceIdentity } from "@/db/voice-schema";
import { consumeVoiceRooms, createOwnedVoiceRoom, retireOwnedVoiceRoom, voiceTransaction } from "@/server/voice-sfu";
import { createCommunity, deleteChannel, deleteCommunity } from "@/server/communities";
import { registerDmDevice } from "@/server/direct-messages";
import { joinVoiceControl, grantBoundVoiceMedia, handleVoiceCrypto, heartbeatVoiceControl, leaveVoiceControl, sweepVoiceLifecycle } from "@/server/voice-control";
import { createBoundVoiceToken, afterAccessChange } from "@/server/voice";
import { Permission } from "@/server/permissions";
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
  it("exposes real consumer failure counts through an empty eligible-call sweep", async () => {
    const f = await fixture(), grant = await grantBoundVoiceMedia(f.auth, f.binding);
    await retireOwnedVoiceRoom(grant.roomName);
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockRejectedValue(new Error("isolated SDK failure"));
    const result = await sweepVoiceLifecycle({ apply: true, now: new Date("2002-01-01"), batchSize: 8, maxBatches: 1 });
    expect(result.scanned).toBe(0);
    expect(result.rooms.claimed).toBeGreaterThanOrEqual(1);
    expect(result.rooms.failed).toBeGreaterThanOrEqual(1);
    expect(result.rooms.unavailable).toBe(0);
  });

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

describe("bounded persistent cleanup", () => {
  it.each([
    { name: "unrestricted empty sources", permission: new ParticipantPermission({ canPublish: true, canPublishSources: [] }), sources: [TrackSource.MICROPHONE] },
    { name: "unrestricted omitted sources", permission: new ParticipantPermission({ canPublish: true }), sources: [TrackSource.MICROPHONE] },
    { name: "disjoint camera permission", permission: new ParticipantPermission({ canPublish: true, canPublishSources: [TrackSource.CAMERA] }), sources: [] },
    { name: "missing permission", permission: undefined, sources: [] },
    { name: "unknown source", permission: new ParticipantPermission({ canPublish: true, canPublishSources: [TrackSource.UNKNOWN] }), sources: [] },
    { name: "foreign source", permission: ParticipantPermission.fromJson({ canPublish: true, canPublishSources: [999] }), sources: [] },
    { name: "mixed sources and data", permission: new ParticipantPermission({ canPublish: true, canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA], canPublishData: true }), sources: [TrackSource.MICROPHONE] },
    { name: "metadata on an existing microphone restriction", permission: new ParticipantPermission({ canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canUpdateMetadata: true }), sources: [TrackSource.MICROPHONE] },
    { name: "disabled publishing with data", permission: new ParticipantPermission({ canPublish: false, canPublishSources: [], canPublishData: true }), sources: [] },
  ])("only narrows $name against canonical microphone authority", async ({ permission, sources }) => {
    const f = await fixture(), p = await peer(f);
    const [everyone] = await db.select().from(role).where(and(eq(role.communityId, f.communityId), eq(role.isDefault, true)));
    await db.insert(channelOverride).values({ channelId: f.snapshot.channelId, roleId: everyone.id, deny: Permission.Video });
    const grant = await grantBoundVoiceMedia(p.auth, p.binding);
    expect(grant.sources).toEqual(["microphone"]);
    const participant = new ParticipantInfo({ identity: grant.participantIdentity, permission });
    vi.mocked(RoomServiceClient.prototype.listParticipants).mockResolvedValue([participant]);
    const update = vi.spyOn(RoomServiceClient.prototype, "updateParticipant").mockResolvedValue(participant);
    await due(grant.roomName);
    const stats = await consumeVoiceRooms({ maxRooms: 1 });
    expect(stats.requests).toBe(2);
    expect(update).toHaveBeenCalledExactlyOnceWith(grant.roomName, grant.participantIdentity, { permission: {
      canSubscribe: false, canPublish: sources.length > 0, canPublishSources: sources, canPublishData: false, canUpdateMetadata: false,
    } });
    expect((await owned(grant.roomName)).status).toBe("active");
  });

  it.each([false, true])("preserves a safe explicit subset with forbidden data=%s even when canonical authority permits more sources", async canPublishData => {
    const f = await fixture(), grant = await grantBoundVoiceMedia(f.auth, f.binding);
    expect(grant.sources).toHaveLength(4);
    const participant = new ParticipantInfo({ identity: grant.participantIdentity, permission: new ParticipantPermission({ canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canSubscribe: true, canPublishData }) });
    vi.mocked(RoomServiceClient.prototype.listParticipants).mockResolvedValue([participant]);
    const update = vi.spyOn(RoomServiceClient.prototype, "updateParticipant").mockResolvedValue(participant);
    await due(grant.roomName);
    expect((await consumeVoiceRooms({ maxRooms: 1 })).requests).toBe(canPublishData ? 2 : 1);
    if (canPublishData) {
      expect(update).toHaveBeenCalledExactlyOnceWith(grant.roomName, grant.participantIdentity, { permission: {
        canSubscribe: true, canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canPublishData: false, canUpdateMetadata: false,
      } });
    } else expect(update).not.toHaveBeenCalled();
    expect((await owned(grant.roomName)).status).toBe("active");
  });

  it("recovers expired claims, fences stale completion, and never overwrites a newer lease", async () => {
    const f = await fixture(), grant = await grantBoundVoiceMedia(f.auth, f.binding);
    await retireOwnedVoiceRoom(grant.roomName);
    const newer = randomUUID(), later = new Date(Date.now() + 120_000);
    await db.update(voiceSfuRoom).set({ nextAttemptAt: new Date(0), leaseToken: randomUUID(), leaseUntil: new Date(0) }).where(eq(voiceSfuRoom.roomName, grant.roomName));
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockImplementation(async name => {
      if (name === grant.roomName) await db.update(voiceSfuRoom).set({ leaseToken: newer, leaseUntil: later, nextAttemptAt: later, lastOutcome: "pending" }).where(eq(voiceSfuRoom.roomName, name));
    });
    const stats = await consumeVoiceRooms({ maxRooms: 1, maxRequests: 1 });
    expect(stats.requests).toBe(1);
    expect(await owned(grant.roomName)).toMatchObject({ leaseToken: newer, lastOutcome: "pending" });
    expect((await owned(grant.roomName)).nextAttemptAt.getTime()).toBe(later.getTime());
  });

  it("orders due work fairly, honors the per-run budget, and retries deleted rooms beyond app expiry", async () => {
    const a = await fixture(), ag = await grantBoundVoiceMedia(a.auth, a.binding);
    const b = await fixture(), bg = await grantBoundVoiceMedia(b.auth, b.binding);
    for (const name of [ag.roomName, bg.roomName]) { await retireOwnedVoiceRoom(name); await due(name); }
    await db.update(voiceSfuRoom).set({ nextAttemptAt: new Date(1), lastAppTokenExpiry: new Date(0) }).where(eq(voiceSfuRoom.roomName, bg.roomName));
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockClear();
    const first = await consumeVoiceRooms({ maxRooms: 1, maxRequests: 1 });
    expect(first).toMatchObject({ claimed: 1, requests: 1, limited: true });
    expect(RoomServiceClient.prototype.deleteRoom).toHaveBeenLastCalledWith(ag.roomName);
    await consumeVoiceRooms({ maxRooms: 1, maxRequests: 1 });
    expect(RoomServiceClient.prototype.deleteRoom).toHaveBeenLastCalledWith(bg.roomName);
    await due(ag.roomName);
    await consumeVoiceRooms({ maxRooms: 1, maxRequests: 1 });
    expect(RoomServiceClient.prototype.deleteRoom).toHaveBeenLastCalledWith(ag.roomName);
    expect(await owned(ag.roomName)).toMatchObject({ status: "retired", lastOutcome: "deleted" });
  });

  it("keeps terminal DB revocation when the SDK rejects and exposes only generic failure counts", async () => {
    const f = await fixture(), grant = await grantBoundVoiceMedia(f.auth, f.binding);
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockRejectedValue(new Error("private SDK body"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await leaveVoiceControl(f.auth, f.binding);
    await due(grant.roomName);
    const stats = await consumeVoiceRooms({ maxRooms: 1, maxRequests: 1 });
    expect(stats.failed).toBe(1);
    expect((await owned(grant.roomName)).status).toBe("retired");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private SDK body");
    await expect(grantBoundVoiceMedia(f.auth, f.binding)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("fails new room grants closed at capacity while an existing reservation remains usable", async () => {
    const existing = await fixture(), grant = await grantBoundVoiceMedia(existing.auth, existing.binding), fresh = await fixture();
    const syntheticChannel = randomUUID(), syntheticCall = randomUUID();
    const count = await db.$count(voiceSfuRoom);
    try {
      await db.execute(sql`insert into voice_sfu_room (room_name, channel_id, call_id, generation, status, retired_at, last_app_token_expiry, next_attempt_at)
        select 'voice:' || ${syntheticChannel} || ':' || ${syntheticCall} || ':' || n::text,
          ${syntheticChannel}::uuid, ${syntheticCall}::uuid, n, 'retired', now(), now(), now() + interval '1 day'
        from generate_series(1, ${100000 - count}) n`);
      expect(await grantBoundVoiceMedia(existing.auth, existing.binding)).toMatchObject({ roomName: grant.roomName });
      await expect(grantBoundVoiceMedia(fresh.auth, fresh.binding)).rejects.toMatchObject({ code: "conflict" });
      expect(await db.$count(voiceSfuRoom, eq(voiceSfuRoom.callId, fresh.snapshot.callId))).toBe(0);
    } finally {
      // Disposable synthetic test resources only; production has no tombstone prune path.
      await db.delete(voiceSfuRoom).where(eq(voiceSfuRoom.channelId, syntheticChannel));
    }
  });
});


it("shares one maintenance room/RPC budget across multiple fast lifecycle batches and keeps dry-run inert", async () => {
  const fixtures = [await fixture(), await fixture(), await fixture()];
  for (const f of fixtures) await db.update(voiceCallMember).set({ leaseExpiresAt: new Date(0) }).where(eq(voiceCallMember.id, f.snapshot.memberId));
  const channelId = randomUUID(), callId = randomUUID();
  try {
    await db.insert(voiceSfuRoom).values(Array.from({ length: 40 }, (_, n) => ({ roomName: `voice:${channelId}:${callId}:${n + 1}`, channelId, callId, generation: n + 1, status: "retired" as const, retiredAt: new Date(0), lastAppTokenExpiry: new Date(0), nextAttemptAt: new Date(0) })));
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockClear();
    await sweepVoiceLifecycle({ apply: false, now: new Date(), batchSize: 1, maxBatches: 3 });
    expect(RoomServiceClient.prototype.deleteRoom).not.toHaveBeenCalled();
    const result = await sweepVoiceLifecycle({ apply: true, now: new Date(), batchSize: 1, maxBatches: 3 });
    expect(result.scanned).toBe(3);
    expect(RoomServiceClient.prototype.deleteRoom).toHaveBeenCalledTimes(16);
    expect(await db.$count(voiceSfuRoom, and(eq(voiceSfuRoom.channelId, channelId), eq(voiceSfuRoom.lastOutcome, "pending")))).toBeGreaterThanOrEqual(24);
  } finally { await db.delete(voiceSfuRoom).where(eq(voiceSfuRoom.channelId, channelId)); }
});


describe("legacy compatibility before coherent activation", () => {
  it("deletes every exact owned legacy channel even when there are more than four", async () => {
    const f = await fixture();
    const channels = await db.insert(channel).values(Array.from({ length: 6 }, (_, n) => ({ communityId: f.communityId, name: `legacy-${n}`, kind: "voice" as const }))).returning();
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockClear();
    await deleteCommunity(f.userId, f.communityId);
    for (const ch of channels) expect(RoomServiceClient.prototype.deleteRoom).toHaveBeenCalledWith(ch.id);
    expect(RoomServiceClient.prototype.deleteRoom).toHaveBeenCalledWith(f.snapshot.channelId);
  });

  it("keeps one delayed exact-channel legacy recheck without scheduling ledger retries", async () => {
    const f = await fixture();
    const timer = vi.spyOn(globalThis, "setTimeout");
    await afterAccessChange(f.communityId);
    const index = timer.mock.calls.findIndex(([, delay]) => delay === 65000);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(timer.mock.calls.filter(([, delay]) => delay === 65000)).toHaveLength(1);
    vi.mocked(RoomServiceClient.prototype.listParticipants).mockClear();
    await timer.mock.calls[index][0]();
    expect(RoomServiceClient.prototype.listParticipants).toHaveBeenCalledWith(f.snapshot.channelId);
    const result = timer.mock.results[index];
    if (result.type === "return") clearTimeout(result.value);
  });
});


it("rechecks session expiry after the observed real PostgreSQL SHARE wait before creating an owned room", async () => {
  const f = await fixture(), grant = await grantBoundVoiceMedia(f.auth, f.binding);
  const expiresAt = new Date(Date.now() + 8000);
  await db.update(session).set({ expiresAt }).where(eq(session.id, f.sessionId));
  const barrier = await db.$client.connect();
  let pending: Promise<void> | undefined;
  try {
    await barrier.query("begin");
    const { rows: [{ pid }] } = await barrier.query<{ pid: number }>("select pg_backend_pid() as pid");
    await barrier.query('select id from "session" where id = $1 for update', [f.sessionId]);
    vi.mocked(RoomServiceClient.prototype.createRoom).mockClear();
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockClear();
    const update = vi.spyOn(RoomServiceClient.prototype, "updateParticipant");
    pending = createOwnedVoiceRoom(grant.roomName);
    const outcome = pending.then(() => null, (error: unknown) => error);
    const deadline = performance.now() + 4000;
    let waiting = false;
    while (performance.now() < deadline) {
      const { rows } = await db.$client.query<{ waiting: boolean }>("select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock') as waiting", [pid]);
      if (rows[0].waiting) { waiting = true; break; }
    }
    expect(waiting).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(expiresAt.getTime() + 1);
    await barrier.query("commit");
    expect(await outcome).toMatchObject({ code: "forbidden" });
    expect(RoomServiceClient.prototype.createRoom).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect((await owned(grant.roomName)).status).toBe("retired");
    expect(RoomServiceClient.prototype.deleteRoom).toHaveBeenCalledWith(grant.roomName);
  } finally {
    await barrier.query("rollback");
    await pending?.catch(() => {});
    vi.useRealTimers();
    barrier.release();
  }
});


it.each(["requests", "deadline"])("leaves precreate retirement durably due with zero RPCs when the %s budget is exhausted", async exhausted => {
  const f = await fixture(), grant = await grantBoundVoiceMedia(f.auth, f.binding);
  await db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.id, f.sessionId));
  const budget = { remainingRequests: exhausted === "requests" ? 0 : 4, deadline: exhausted === "deadline" ? 0 : performance.now() + 2500 };
  vi.mocked(RoomServiceClient.prototype.createRoom).mockClear();
  vi.mocked(RoomServiceClient.prototype.deleteRoom).mockClear();
  vi.mocked(RoomServiceClient.prototype.listParticipants).mockClear();
  const update = vi.spyOn(RoomServiceClient.prototype, "updateParticipant");
  await expect(createOwnedVoiceRoom(grant.roomName, budget)).rejects.toMatchObject({ code: "forbidden" });
  expect(RoomServiceClient.prototype.createRoom).not.toHaveBeenCalled();
  expect(RoomServiceClient.prototype.deleteRoom).not.toHaveBeenCalled();
  expect(RoomServiceClient.prototype.listParticipants).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect((await owned(grant.roomName)).status).toBe("retired");
  expect((await owned(grant.roomName)).nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
});

it("never signs after its own final grant consumer terminally retires an unexpected SFU roster", async () => {
  const f = await fixture();
  vi.mocked(RoomServiceClient.prototype.createRoom).mockImplementation(async options => {
    await due(options.name);
    vi.mocked(RoomServiceClient.prototype.listParticipants).mockResolvedValue([new ParticipantInfo({ identity: "unowned-participant" })]);
    return new Room({ name: options.name });
  });
  const sign = vi.spyOn(AccessToken.prototype, "toJwt");
  await expect(createBoundVoiceToken(f.auth, f.binding)).rejects.toMatchObject({ code: "forbidden" });
  expect(sign).not.toHaveBeenCalled();
  const [row] = await db.select().from(voiceSfuRoom).where(eq(voiceSfuRoom.callId, f.snapshot.callId));
  expect(row.status).toBe("retired");
});

it("shares four SDK requests across reservation cleanup, explicit creation and final grant cleanup", async () => {
  const f = await fixture(), channelId = randomUUID(), callId = randomUUID();
  try {
    await db.insert(voiceSfuRoom).values(Array.from({ length: 12 }, (_, n) => ({ roomName: `voice:${channelId}:${callId}:${n + 1}`, channelId, callId, generation: n + 1, status: "retired" as const, retiredAt: new Date(0), lastAppTokenExpiry: new Date(0), nextAttemptAt: new Date(0) })));
    vi.mocked(RoomServiceClient.prototype.createRoom).mockClear();
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockClear();
    vi.mocked(RoomServiceClient.prototype.listParticipants).mockClear();
    const token = await createBoundVoiceToken(f.auth, f.binding);
    expect(token.roomName).toBe(`voice:${f.snapshot.channelId}:${f.snapshot.callId}:${f.snapshot.generation}`);
    const requests = vi.mocked(RoomServiceClient.prototype.createRoom).mock.calls.length + vi.mocked(RoomServiceClient.prototype.deleteRoom).mock.calls.length + vi.mocked(RoomServiceClient.prototype.listParticipants).mock.calls.length;
    expect(RoomServiceClient.prototype.createRoom).toHaveBeenCalledTimes(1);
    expect(requests).toBeLessThanOrEqual(4);
    expect(await db.$count(voiceSfuRoom, and(eq(voiceSfuRoom.channelId, channelId), eq(voiceSfuRoom.lastOutcome, "pending")))).toBeGreaterThanOrEqual(9);
  } finally { await db.delete(voiceSfuRoom).where(eq(voiceSfuRoom.channelId, channelId)); }
});

it("keeps one monotonic token deadline after time passes between explicit creation and cleanup", async () => {
  const f = await fixture(), channelId = randomUUID(), callId = randomUUID();
  let now = 0;
  const starts: number[] = [];
  try {
    await db.insert(voiceSfuRoom).values(Array.from({ length: 12 }, (_, n) => ({ roomName: `voice:${channelId}:${callId}:${n + 1}`, channelId, callId, generation: n + 1, status: "retired" as const, retiredAt: new Date(0), lastAppTokenExpiry: new Date(0), nextAttemptAt: new Date(0) })));
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(RoomServiceClient.prototype.deleteRoom).mockImplementation(async () => { starts.push(now); now += 100; });
    vi.mocked(RoomServiceClient.prototype.listParticipants).mockImplementation(async () => { starts.push(now); now += 100; return []; });
    vi.mocked(RoomServiceClient.prototype.createRoom).mockImplementation(async options => {
      starts.push(now);
      // A synchronous process pause after SDK completion also spends the same monotonic budget.
      now += 2000;
      return new Room({ name: options.name });
    });
    await createBoundVoiceToken(f.auth, f.binding);
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(starts.every(start => start + 500 <= 2500)).toBe(true);
  } finally { await db.delete(voiceSfuRoom).where(eq(voiceSfuRoom.channelId, channelId)); }
});
