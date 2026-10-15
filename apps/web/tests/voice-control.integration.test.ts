import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { channel, session } from "@/db/schema";
import { createCommunity } from "@/server/communities";
import { registerDmDevice } from "@/server/direct-messages";
import { joinVoiceControl } from "@/server/voice-control";
import { testUsers } from "./helpers";

const users = testUsers();
let userId: string, channelId: string;
const sessionId = randomUUID(), anchorDeviceId = randomUUID();
const anchorSecret = randomBytes(32).toString("hex"), enrollmentSecret = randomBytes(32).toString("hex");
const joinNonce = randomUUID(), voiceDeviceId = randomUUID();
const auth = () => ({ userId, sessionId, anchorDeviceId, anchorSecret });
const join = () => ({ channelId, joinNonce, voiceDeviceId, enrollmentSecret, consent: true });
beforeAll(async () => {
  userId = await users.create("Voice control draft");
  await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Enrollment only" });
  const c = await createCommunity(userId, "Voice control draft");
  const [ch] = await db.insert(channel).values({ communityId: c.communityId, name: "voice-draft", kind: "voice" }).returning({ id: channel.id });
  channelId = ch.id;
});
afterAll(() => users.cleanup());

describe("unactivated voice control server admission", () => {
  it("creates a server-owned namespace and preserves the entire exact nonce binding", async () => {
    const first = await joinVoiceControl(auth(), join());
    expect(first).toMatchObject({ channelId, joinNonce, voiceDeviceId, generation: 1 });
    expect(first.voiceUserId).toBe(`@voice_${first.memberId}:opendiscord.local`);
    expect(first.participantIdentity).toBe(`v1:${first.memberId}`);
    expect(await joinVoiceControl(auth(), join())).toMatchObject({ memberId: first.memberId, callId: first.callId });
    expect(JSON.stringify(first)).not.toContain(enrollmentSecret);
  });
  it("rejects nonce reuse with a different secret, voice device or session", async () => {
    for (const changed of [{ enrollmentSecret: randomBytes(32).toString("hex") }, { voiceDeviceId: randomUUID() }]) {
      await expect(joinVoiceControl(auth(), { ...join(), ...changed })).rejects.toMatchObject({ code: "conflict" });
    }
    const otherSession = randomUUID();
    await db.insert(session).values({ id: otherSession, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
    await expect(joinVoiceControl({ ...auth(), sessionId: otherSession }, join())).rejects.toMatchObject({ code: "conflict" });
  });
});
