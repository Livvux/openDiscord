import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { channel, session } from "@/db/schema";
import { voiceCallMember } from "@/db/voice-schema";
import { createCommunity } from "@/server/communities";
import { registerDmDevice } from "@/server/direct-messages";
import { grantBoundVoiceMedia, joinVoiceControl } from "@/server/voice-control";
import { createBoundVoiceToken } from "@/server/voice";
import { testUsers } from "./helpers";

const users = testUsers();
afterAll(() => users.cleanup());
async function fixture() {
  const userId = await users.create("Bound grant"), sessionId = randomUUID(), anchorDeviceId = randomUUID(), anchorSecret = randomBytes(32).toString("hex"), secret = randomBytes(32).toString("hex");
  await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) });
  await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Grant anchor" });
  const c = await createCommunity(userId, "Grant fixture");
  const [ch] = await db.insert(channel).values({ communityId: c.communityId, name: "voice", kind: "voice" }).returning();
  const snapshot = await joinVoiceControl({ userId, sessionId, anchorDeviceId, anchorSecret }, { channelId: ch.id, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: secret, consent: true });
  return { userId, sessionId, anchorDeviceId, secret, snapshot,
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
