import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AccessToken, Room, RoomServiceClient } from "livekit-server-sdk";
import { db } from "@/db";
import { channel, session, member, role } from "@/db/schema";
import { voiceCallMember } from "@/db/voice-schema";
import { createCommunity } from "@/server/communities";
import { registerDmDevice, revokeDmDevice } from "@/server/direct-messages";
import { grantBoundVoiceMedia, joinVoiceControl } from "@/server/voice-control";
import { createBoundVoiceToken } from "@/server/voice";
import { blockUser } from "@/server/blocks";
import { updateRole } from "@/server/moderation";
import { testUsers } from "./helpers";

// Public SDK mocks: this suite proves SQL/token boundaries, not live SFU acceptance.
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

describe("unreachable bound media authorization", () => {
  it("captures exact binding, current source permissions and unchanged lease without secrets", async () => {
    const f = await fixture();
    const grant = await grantBoundVoiceMedia(f.auth, f.binding);
    expect(grant).toMatchObject({ roomName: `voice:${f.snapshot.channelId}:${f.snapshot.callId}:${f.snapshot.generation}`, participantIdentity: `v1:${f.snapshot.memberId}`, sources: ["microphone", "camera", "screen_share", "screen_share_audio"], canPublishData: false, snapshot: { memberId: f.snapshot.memberId, generation: f.snapshot.generation } });
    expect(JSON.stringify(grant)).not.toContain(f.secret);
    expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(Date.parse(f.snapshot.leaseExpiresAt));
    const [member] = await db.select().from(voiceCallMember).where(eq(voiceCallMember.id, f.snapshot.memberId));
    expect(member.leaseExpiresAt.toISOString()).toBe(f.snapshot.leaseExpiresAt);
  });
  it("rejects wrong possession, session, nonce and stale generation", async () => {
    const f = await fixture();
    for (const auth of [{ ...f.auth, secret: "0".repeat(64) }, { ...f.auth, sessionId: randomUUID() }, { ...f.auth, memberId: randomUUID() }]) {
      await expect(grantBoundVoiceMedia(auth, f.binding)).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(grantBoundVoiceMedia(f.auth, { ...f.binding, joinNonce: randomUUID() })).rejects.toMatchObject({ code: "forbidden" });
    await expect(grantBoundVoiceMedia(f.auth, { ...f.binding, expectedGeneration: f.binding.expectedGeneration + 1 })).rejects.toMatchObject({ code: "conflict" });
  });
  it("signs only exact generation room and member identity with data disabled and bounded expiry", async () => {
    const f = await fixture(), result = await createBoundVoiceToken(f.auth, f.binding);
    const claims = JSON.parse(Buffer.from(result.token.split(".")[1], "base64url").toString()) as { sub: string; exp: number; nbf: number; video: Record<string, unknown> };
    expect(claims.sub).toBe(`v1:${f.snapshot.memberId}`);
    expect(claims.video).toMatchObject({ room: `voice:${f.snapshot.channelId}:${f.snapshot.callId}:${f.snapshot.generation}`, roomJoin: true, canPublish: true, canSubscribe: true, canPublishSources: ["microphone", "camera", "screen_share", "screen_share_audio"], canPublishData: false });
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(60);
    expect(claims.exp * 1000).toBeLessThanOrEqual(Date.parse(f.snapshot.leaseExpiresAt));
    expect(JSON.stringify(claims)).not.toContain(f.secret);
    expect(Object.keys(claims).sort()).toEqual(["exp", "iss", "nbf", "sub", "video"]);
  });
});

async function peer(f: Awaited<ReturnType<typeof fixture>>) {
  const userId = await users.create("Grant peer"), sessionId = randomUUID(), anchorDeviceId = randomUUID(), anchorSecret = randomBytes(32).toString("hex"), secret = randomBytes(32).toString("hex");
  await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) });
  await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Grant peer" });
  await db.insert(member).values({ communityId: f.communityId, userId });
  const snapshot = await joinVoiceControl({ userId, sessionId, anchorDeviceId, anchorSecret }, { channelId: f.snapshot.channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: secret, consent: true });
  return { userId, sessionId, anchorDeviceId, auth: { userId, sessionId, memberId: snapshot.memberId, secret }, binding: { callId: snapshot.callId, memberId: snapshot.memberId, joinNonce: snapshot.joinNonce, expectedGeneration: snapshot.generation }, snapshot };
}
async function waiters(expected: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { rows } = await db.$client.query<{ count: number }>("select count(*)::int as count from pg_locks where locktype = 'advisory' and classid = 0 and objid = 810030 and not granted");
    if (rows[0].count >= expected) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Expected observed Voice lock waiters");
}
type F = Awaited<ReturnType<typeof fixture>>;
type P = Awaited<ReturnType<typeof peer>>;
const mutations: { name: string; run: (f: F, p: P) => Promise<unknown> }[] = [
  { name: "anchor revoke", run: (_f, p) => revokeDmDevice(p.userId, p.anchorDeviceId) },
  { name: "role source loss", run: async (f) => { const [r] = await db.select().from(role).where(and(eq(role.communityId, f.communityId), eq(role.isDefault, true))); await updateRole(f.userId, r.id, "everyone", ["ViewChannels", "Connect", "Speak", "SendMessages", "CreateInvites"]); } },
  { name: "block", run: (f, p) => blockUser(f.userId, p.userId) },
  { name: "native session delete", run: async (_f, p) => { await db.delete(session).where(eq(session.id, p.sessionId)); } },
];
describe("bound grant serialized against actual lifecycle mutations", () => {
  for (const mutation of mutations) {
    it(`${mutation.name} commits before queued stale token grant`, async () => {
      const f = await fixture(), p = await peer(f), barrier = await db.$client.connect();
      let mutating: Promise<unknown> | undefined, granting: Promise<unknown> | undefined;
      try {
        await barrier.query("begin");
        await barrier.query("set local statement_timeout = '6s'");
        await barrier.query("select pg_advisory_xact_lock(810030)");
        mutating = mutation.run(f, p);
        const mutationOutcome = mutating.then(() => null, (error: unknown) => error);
        await waiters(1);
        granting = grantBoundVoiceMedia(p.auth, p.binding);
        const grantOutcome = granting.then(() => null, (error: unknown) => error);
        await waiters(2);
        await barrier.query("commit");
        expect(await mutationOutcome).toBeNull();
        expect(await grantOutcome).toMatchObject({ code: "forbidden" });
      } finally {
        await barrier.query("rollback");
        await Promise.allSettled([mutating, granting]);
        barrier.release();
      }
    });
  }
  it("uses current Connect-only authority rather than account defaults or previous JWT claims", async () => {
    const f = await fixture();
    const [r] = await db.select().from(role).where(and(eq(role.communityId, f.communityId), eq(role.isDefault, true)));
    await updateRole(f.userId, r.id, "everyone", ["ViewChannels", "Connect"]);
    const p = await peer(f);
    const grant = await grantBoundVoiceMedia(p.auth, p.binding);
    expect(grant.sources).toEqual([]);
    const result = await createBoundVoiceToken(p.auth, p.binding);
    const claims = JSON.parse(Buffer.from(result.token.split(".")[1], "base64url").toString()) as { video: Record<string, unknown> };
    expect(claims.video).toMatchObject({ canPublish: false, canPublishSources: [], canPublishData: false });
  });
  it("bounds the grant by real session freshness and refuses an expired lease", async () => {
    const f = await fixture(), expiresAt = new Date(Date.now() + 8000);
    await db.update(session).set({ expiresAt }).where(eq(session.id, f.sessionId));
    const grant = await grantBoundVoiceMedia(f.auth, f.binding);
    expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(expiresAt.getTime());
    await db.update(voiceCallMember).set({ leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(voiceCallMember.id, f.snapshot.memberId));
    await expect(grantBoundVoiceMedia(f.auth, f.binding)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("discards a genuine signed JWT when delayed SDK relative expiry exceeds grant freshness", async () => {
    const f = await fixture(), sign = AccessToken.prototype.toJwt;
    const delayed = vi.spyOn(AccessToken.prototype, "toJwt").mockImplementationOnce(async function (this: AccessToken) {
      // Reproduce a synchronous pause before the SDK computes its relative exp; still sign with
      // the installed real SDK. Only Date is faked after the database grant has committed.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 5000);
      return sign.call(this);
    });
    try {
      const rejected = await createBoundVoiceToken(f.auth, f.binding).then(() => false, (error: unknown) => {
        expect(error).toMatchObject({ code: "forbidden" });
        return true;
      });
      expect(rejected, "Delayed SDK expiry must not outlive the authenticated grant").toBe(true);
    } finally {
      vi.useRealTimers();
      delayed.mockRestore();
    }
  });
  it("keeps media activation separate and all external SDK work outside control transactions", () => {
    const provider = readFileSync(new URL("../src/components/app/voice/voice-provider.tsx", import.meta.url), "utf8");
    expect(provider).not.toMatch(/crypto-owner|http-client|VoiceCryptoOwner/);
    const control = readFileSync(new URL("../src/server/voice-control.ts", import.meta.url), "utf8");
    expect(control).not.toMatch(/livekit-server-sdk|new AccessToken|RoomServiceClient|fetch\(/);
    const signer = readFileSync(new URL("../src/server/voice.ts", import.meta.url), "utf8").split("export async function createBoundVoiceToken")[1].split("export interface VoiceParticipant")[0];
    expect(signer.indexOf("await grantBoundVoiceMedia")).toBeGreaterThanOrEqual(0);
    expect(signer.indexOf("new AccessToken")).toBeGreaterThan(signer.indexOf("await grantBoundVoiceMedia"));
  });
});
