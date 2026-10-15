import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { abuseReport, channel, dmIdentity, instanceAdmin, instanceSettings, member, role, session, user } from "@/db/schema";
import { voiceCall, voiceCallMember } from "@/db/voice-schema";
import { createCommunity, deleteChannel, deleteCommunity, leaveCommunity, setChannelOverride } from "@/server/communities";
import { registerDmDevice, revokeDmDevice } from "@/server/direct-messages";
import { handleVoiceCrypto, heartbeatVoiceControl, joinVoiceControl, sweepVoiceLifecycle } from "@/server/voice-control";
import { banMember, createRole, deleteRole, kickMember, setMemberRole, updateRole } from "@/server/moderation";
import { resetDmIdentity } from "@/server/dm-reset";
import { revokeUserSessions, setUserSuspension, setCommunitySuspension, setApproval, setClosedAlpha, setInstanceAdmin, transferCommunity, resolveReport } from "@/server/instance-admin";
import { createIntegration } from "@/server/integrations";
import { blockUser, unblockUser } from "@/server/blocks";
import { Permission } from "@/server/permissions";
import { auth } from "@/lib/auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import { runMaintenance } from "@/server/maintenance";
import { testUsers } from "./helpers";

const users = testUsers();
const adminIds: string[] = [];
afterAll(async () => { if (adminIds.length) await db.delete(instanceAdmin).where(inArray(instanceAdmin.userId, adminIds)); await users.cleanup(); });
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
  return { userId, sessionId, anchorDeviceId, anchorSecret, secret, snapshot };
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

describe("bounded Voice maintenance progress", () => {
  it("skips a healthy prefix before LIMIT and progresses across bounded repeated runs", async () => {
    const healthy = await fixture();
    const tails = [await fixture(), await fixture(), await fixture()];
    // Isolate this test's eligibility using a historical reference time.
    const now = new Date("2001-01-01T00:00:00Z");
    for (const f of tails) await db.update(voiceCallMember).set({ leaseExpiresAt: new Date("2000-01-01T00:00:00Z") }).where(eq(voiceCallMember.id, f.snapshot.memberId));
    const dry = await sweepVoiceLifecycle({ apply: false, now, batchSize: 1, maxBatches: 1 });
    expect(dry.scanned).toBe(3);
    for (const f of tails) expect(await state(f.snapshot.memberId)).toBe("waiting");
    for (let i = 0; i < tails.length; i++) {
      const result = await sweepVoiceLifecycle({ apply: true, now, batchSize: 1, maxBatches: 1 });
      expect(result.scanned).toBe(1);
      expect(result.closed).toBe(1);
      expect(result.removed).toBe(1);
    }
    expect((await sweepVoiceLifecycle({ apply: true, now, batchSize: 1, maxBatches: 1 })).scanned).toBe(0);
    expect(await state(healthy.snapshot.memberId)).toBe("waiting");
    for (const f of tails) expect(await state(f.snapshot.memberId)).toBe("left");
  });
});

async function observeVoiceWait(pid: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { rows } = await db.$client.query<{ waiting: boolean }>("select exists(select 1 from pg_locks where pid = $1 and locktype = 'advisory' and classid = 0 and objid = 810030 and not granted) as waiting", [pid]);
    if (rows[0].waiting) return;
  }
  throw new Error("Native adapter did not reach the observed Voice barrier");
}
describe("pinned BetterAuth1.7.7 PostgreSQL adapter boundaries", () => {
  for (const model of ["session", "user"] as const) {
    it(`serializes actual native adapter ${model} deletion before a queued peer heartbeat`, async () => {
      const f = await fixture(), p = await peer(f), blocker = await db.$client.connect();
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, application_name: `voice-native-${randomUUID()}`, statement_timeout: 6000, lock_timeout: 5000 });
      const statements: string[] = [];
      const nativeDb = drizzle(pool, { schema, logger: { logQuery(query) { statements.push(query); } } });
      const native = drizzleAdapter(nativeDb, { provider: "pg", schema })(auth.options);
      let deleting: Promise<unknown> | undefined;
      try {
        const { rows: [{ pid }] } = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
        await blocker.query("begin");
        await blocker.query("select pg_advisory_xact_lock(810030)");
        deleting = native.delete({ model, where: [{ field: "id", value: model === "session" ? p.sessionId : p.userId }] });
        const deletion = deleting.then(() => null, (error: unknown) => error);
        await observeVoiceWait(pid);
        // The native statement is already queued at Voice; release only after observing overlap.
        const heartbeat = heartbeatVoiceControl({ userId: p.userId, sessionId: p.sessionId, memberId: p.snapshot.memberId, secret: p.secret }, { callId: p.snapshot.callId, memberId: p.snapshot.memberId, joinNonce: p.snapshot.joinNonce, expectedGeneration: p.snapshot.generation });
        const outcome = heartbeat.then(value => ({ value }), (error: unknown) => ({ error }));
        const deadline = Date.now() + 4000;
        let overlapping = false;
        while (Date.now() < deadline) {
          const { rows } = await db.$client.query<{ count: number }>("select count(*)::int as count from pg_locks where locktype = 'advisory' and classid = 0 and objid = 810030 and not granted");
          if (rows[0].count >= 2) { overlapping = true; break; }
        }
        expect(overlapping).toBe(true);
        await blocker.query("commit");
        expect(await deletion).toBeNull();
        expect(await outcome).toHaveProperty("error");
        expect(await state(p.snapshot.memberId)).toBeUndefined();
        const [call] = await db.select().from(voiceCall).where(eq(voiceCall.id, f.snapshot.callId));
        expect(call.generation).toBe(p.snapshot.generation + 1);
        expect(await state(f.snapshot.memberId)).toBe("waiting");
        // Default configured adapter emits standalone DELETE, not an imagined request-wide transaction.
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/^delete from/);
      } finally {
        await blocker.query("rollback");
        await deleting?.catch(() => {});
        blocker.release(); await pool.end();
      }
    });
  }
});

async function voiceWaiters(count: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { rows } = await db.$client.query<{ count: number }>("select count(*)::int as count from pg_locks where locktype = 'advisory' and classid = 0 and objid = 810030 and not granted");
    if (rows[0].count >= count) return;
  }
  throw new Error(`Expected ${count} actual PostgreSQL Voice waiters`);
}
type F = Awaited<ReturnType<typeof fixture>>;
type P = Awaited<ReturnType<typeof peer>>;
const scopedMutations: { name: string; run: (f: F, p: P) => Promise<unknown> }[] = [
  { name: "leave", run: (f, p) => leaveCommunity(p.userId, f.communityId) },
  { name: "kick", run: (f, p) => kickMember(f.userId, f.communityId, p.userId) },
  { name: "ban", run: (f, p) => banMember(f.userId, f.communityId, p.userId) },
  { name: "anchor revoke", run: (_f, p) => revokeDmDevice(p.userId, p.anchorDeviceId) },
  { name: "source override", run: async (f) => { const [r] = await db.select().from(role).where(and(eq(role.communityId, f.communityId), eq(role.isDefault, true))); await setChannelOverride(f.userId, f.channelId, r.id, 0, Permission.Video); } },
  { name: "default role loss", run: async (f) => { const [r] = await db.select().from(role).where(and(eq(role.communityId, f.communityId), eq(role.isDefault, true))); await updateRole(f.userId, r.id, "everyone", ["ViewChannels", "Connect", "Speak", "SendMessages", "CreateInvites"]); } },
];
describe("actual lifecycle mutators versus queued crypto with observed overlap", () => {
  for (const mutation of scopedMutations) {
    it(`${mutation.name} commits terminal invalidation before stale crypto can proceed`, async () => {
      const f = await fixture(), p = await peer(f), barrier = await db.$client.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await barrier.query("begin"); await barrier.query("set local statement_timeout = '6s'");
        await barrier.query("select pg_advisory_xact_lock(810030)");
        pending = mutation.run(f, p);
        const mutationOutcome = pending.then(() => null, (error: unknown) => error);
        await voiceWaiters(1);
        expect(await state(p.snapshot.memberId)).toBe("waiting");
        const crypto = handleVoiceCrypto({ userId: p.userId, sessionId: p.sessionId, memberId: p.snapshot.memberId, secret: p.secret }, { callId: p.snapshot.callId, memberId: p.snapshot.memberId, joinNonce: p.snapshot.joinNonce, expectedGeneration: p.snapshot.generation, request: { kind: "sync" } });
        const cryptoOutcome = crypto.then(() => null, (error: unknown) => error);
        await voiceWaiters(2);
        await barrier.query("commit");
        expect(await mutationOutcome).toBeNull();
        expect(await cryptoOutcome).toMatchObject({ code: "forbidden" });
        expect(await state(p.snapshot.memberId)).toBe("left");
      } finally { await barrier.query("rollback"); await pending?.catch(() => {}); barrier.release(); }
    });
  }
  it("keeps the same user's unrelated community enrollment live after a scoped kick", async () => {
    const f = await fixture(), p = await peer(f), other = await fixture();
    await db.insert(member).values({ communityId: other.communityId, userId: p.userId });
    const unrelated = await joinVoiceControl(p, { channelId: other.channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: randomBytes(32).toString("hex"), consent: true });
    await kickMember(f.userId, f.communityId, p.userId);
    expect(await state(p.snapshot.memberId)).toBe("left");
    expect(await state(unrelated.memberId)).toBe("waiting");
  });
  it("compares role deletion and deny-role assignment using effective channel authority", async () => {
    const f = await fixture(), p = await peer(f);
    const r = await createRole(f.userId, f.communityId, "Voice source", []);
    await setChannelOverride(f.userId, f.channelId, r, 0, Permission.Speak);
    await setMemberRole(f.userId, r, p.userId, true);
    expect(await state(p.snapshot.memberId)).toBe("left");
    const q = await peer(f);
    const source = await createRole(f.userId, f.communityId, "Explicit speak", ["Speak"]);
    await setMemberRole(f.userId, source, q.userId, true);
    const [everyone] = await db.select().from(role).where(and(eq(role.communityId, f.communityId), eq(role.isDefault, true)));
    await setChannelOverride(f.userId, f.channelId, everyone.id, 0, Permission.Speak);
    await setChannelOverride(f.userId, f.channelId, source, Permission.Speak, 0);
    // A fresh enrollment is needed after the intervening source loss.
    const fresh = await joinVoiceControl(q, { channelId: f.channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: randomBytes(32).toString("hex"), consent: true });
    await deleteRole(f.userId, source);
    expect(await state(fresh.memberId)).toBe("left");
  });
  for (const kind of ["bot", "webhook"] as const) {
    it(`prelocks both-kind integration creation (${kind}) before community rows without revoking Voice`, async () => {
      const f = await fixture(), p = await peer(f), barrier = await db.$client.connect();
      const [text] = await db.select().from(channel).where(and(eq(channel.communityId, f.communityId), eq(channel.kind, "text")));
      let pending: Promise<unknown> | undefined;
      try {
        await barrier.query("begin"); await barrier.query("set local lock_timeout = '2s'");
        await barrier.query("select pg_advisory_xact_lock(810030)");
        pending = createIntegration(f.userId, f.communityId, { kind, name: "Ordered integration", ...(kind === "webhook" ? { channelId: text.id } : {}) });
        const result = pending.then(() => null, (error: unknown) => error);
        await voiceWaiters(1);
        // If creation took community before Voice, this real row lock would time out.
        await barrier.query("select id from public.community where id = $1 for update", [f.communityId]);
        await barrier.query("commit");
        expect(await result).toBeNull();
        expect(await state(f.snapshot.memberId)).toBe("waiting");
        expect(await state(p.snapshot.memberId)).toBe("waiting");
      } finally { await barrier.query("rollback"); await pending?.catch(() => {}); barrier.release(); }
    });
  }
  for (const scope of ["channel", "community"] as const) {
    it(`${scope} deletion leaves no live cascaded Voice artifacts`, async () => {
      const f = await fixture();
      if (scope === "channel") await deleteChannel(f.userId, f.channelId);
      else await deleteCommunity(f.userId, f.communityId);
      expect(await db.$count(voiceCall, eq(voiceCall.id, f.snapshot.callId))).toBe(0);
      expect(await state(f.snapshot.memberId)).toBeUndefined();
    });
  }
});

async function admin(f: F) { await db.insert(instanceAdmin).values({ userId: f.userId }).onConflictDoNothing(); adminIds.push(f.userId); return { userId: f.userId, sessionId: f.sessionId }; }
async function preservingSettings(fn: () => Promise<void>) {
  const previous = await db.select().from(instanceSettings);
  try { await fn(); } finally { await db.delete(instanceSettings); if (previous.length) await db.insert(instanceSettings).values(previous); }
}
describe("account and community policy lifecycle", () => {
  for (const operation of ["revoke sessions", "suspend account", "reject pending"] as const) {
    it(`${operation} invalidates before native cascade without duplicate generation bump`, async () => {
      const f = await fixture(), p = await peer(f), actor = await admin(f);
      if (operation === "reject pending") await db.update(user).set({ approvalStatus: "pending" }).where(eq(user.id, p.userId));
      if (operation === "revoke sessions") await revokeUserSessions(actor, p.userId, "Lifecycle regression");
      else if (operation === "suspend account") await setUserSuspension(actor, p.userId, true, "Lifecycle regression");
      else await setApproval(actor, p.userId, "rejected", "Lifecycle regression");
      expect(await state(p.snapshot.memberId)).toBeUndefined();
      const [call] = await db.select().from(voiceCall).where(eq(voiceCall.id, f.snapshot.callId));
      expect(call.generation).toBe(p.snapshot.generation + 1);
      expect(await state(f.snapshot.memberId)).toBe("waiting");
    });
  }
  it("community suspension and report suspension terminate only scoped calls", async () => {
    const f = await fixture(), p = await peer(f), unrelated = await fixture(), actor = await admin(f);
    await setCommunitySuspension(actor, f.communityId, true, "Lifecycle regression");
    expect(await state(f.snapshot.memberId)).toBe("left"); expect(await state(p.snapshot.memberId)).toBe("left");
    expect(await state(unrelated.snapshot.memberId)).toBe("waiting");
    await setCommunitySuspension(actor, f.communityId, false, "Lifecycle regression");
    expect(await state(p.snapshot.memberId)).toBe("left");
    const [report] = await db.insert(abuseReport).values({ reporterId: f.userId, communityId: unrelated.communityId, reason: "Lifecycle report" }).returning();
    await resolveReport(actor, report.id, "removed", "Lifecycle report regression");
    expect(await state(unrelated.snapshot.memberId)).toBe("left");
  });
  it("owner transfer invalidates capability loss and never revives the new owner's prior enrollment", async () => {
    const f = await fixture(), p = await peer(f), actor = await admin(f);
    const [everyone] = await db.select().from(role).where(and(eq(role.communityId, f.communityId), eq(role.isDefault, true)));
    await setChannelOverride(f.userId, f.channelId, everyone.id, 0, Permission.Video);
    expect(await state(p.snapshot.memberId)).toBe("left");
    const [target] = await db.select({ email: user.email }).from(user).where(eq(user.id, p.userId));
    await transferCommunity(actor, f.communityId, target.email, "Lifecycle transfer regression");
    expect(await state(f.snapshot.memberId)).toBe("left");
    expect(await state(p.snapshot.memberId)).toBe("left");
  });
  it("enabling alpha removes pending membership but approved accounts survive", async () => preservingSettings(async () => {
    const f = await fixture(), p = await peer(f), actor = await admin(f);
    await db.update(user).set({ approvalStatus: "pending" }).where(eq(user.id, p.userId));
    await setClosedAlpha(actor, true, "Lifecycle alpha regression");
    expect(await state(p.snapshot.memberId)).toBe("left"); expect(await state(f.snapshot.memberId)).toBe("waiting");
    await setClosedAlpha(actor, false, "Lifecycle alpha regression");
    expect(await state(p.snapshot.memberId)).toBe("left");
  }));
  it("removing a legacy pending admin exemption follows actual alpha policy", async () => preservingSettings(async () => {
    const f = await fixture(), p = await peer(f), actor = await admin(f);
    await db.insert(instanceAdmin).values({ userId: p.userId }); adminIds.push(p.userId);
    await db.update(user).set({ approvalStatus: "pending" }).where(eq(user.id, p.userId));
    await setClosedAlpha(actor, true, "Lifecycle exemption regression");
    expect(await state(p.snapshot.memberId)).toBe("waiting");
    await setInstanceAdmin(actor, p.userId, false, "Lifecycle exemption regression");
    expect(await state(p.snapshot.memberId)).toBe("left");
  }));
  it("identity reset atomically invalidates all account voice before anchor/session deletion", async () => {
    const f = await fixture(), p = await peer(f);
    const publicKey = "a".repeat(43);
    const keys = { master_key: { keys: { [`ed25519:${publicKey}`]: publicKey } } };
    await db.insert(dmIdentity).values({ userId: p.userId, keys });
    // Installed reset API requires the exact existing public identity fingerprint and fresh auth gate.
    const { createHash } = await import("node:crypto");
    const identity = createHash("sha256").update(JSON.stringify([[`ed25519:${publicKey}`, publicKey]])).digest("hex");
    await resetDmIdentity(p.userId, p.sessionId, { identity, twoFactorEnabled: false });
    expect(await state(p.snapshot.memberId)).toBeUndefined();
    const [call] = await db.select().from(voiceCall).where(eq(voiceCall.id, f.snapshot.callId));
    expect(call.generation).toBe(p.snapshot.generation + 1);
    expect(await state(f.snapshot.memberId)).toBe("waiting");
  });
});

describe("native account write granularity and multi-session cascades", () => {
  it("native user profile/TOTP edits retain valid enrollment until an actual session deletion", async () => {
    const f = await fixture(), p = await peer(f);
    const native = drizzleAdapter(db, { provider: "pg", schema })(auth.options);
    await native.update({ model: "user", where: [{ field: "id", value: p.userId }], update: { name: "Updated native profile", twoFactorEnabled: true } });
    expect(await state(p.snapshot.memberId)).toBe("waiting");
    const current = await heartbeatVoiceControl({ userId: p.userId, sessionId: p.sessionId, memberId: p.snapshot.memberId, secret: p.secret }, { callId: p.snapshot.callId, memberId: p.snapshot.memberId, joinNonce: p.snapshot.joinNonce, expectedGeneration: p.snapshot.generation });
    expect(current.generation).toBe(p.snapshot.generation);
    await native.deleteMany({ model: "session", where: [{ field: "userId", value: p.userId }] });
    expect(await state(p.snapshot.memberId)).toBeUndefined();
  });
  it("actual native all-session delete advances each surviving call exactly once", async () => {
    const f = await fixture(), p = await peer(f), other = await fixture();
    await db.insert(member).values({ communityId: other.communityId, userId: p.userId });
    const secondSession = randomUUID();
    await db.insert(session).values({ id: secondSession, userId: p.userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
    const second = await joinVoiceControl({ ...p, sessionId: secondSession }, { channelId: other.channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: randomBytes(32).toString("hex"), consent: true });
    const native = drizzleAdapter(db, { provider: "pg", schema })(auth.options);
    await native.deleteMany({ model: "session", where: [{ field: "userId", value: p.userId }] });
    for (const snapshot of [p.snapshot, second]) {
      expect(await state(snapshot.memberId)).toBeUndefined();
      const [call] = await db.select().from(voiceCall).where(eq(voiceCall.id, snapshot.callId));
      expect(call.generation).toBe(snapshot.generation + 1);
    }
    expect(await state(f.snapshot.memberId)).toBe("waiting");
    expect(await state(other.snapshot.memberId)).toBe("waiting");
  });
});
