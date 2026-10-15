import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { db } from "@/db";
import { channel, session } from "@/db/schema";
import { createCommunity } from "@/server/communities";
import { registerDmDevice } from "@/server/direct-messages";
import { joinVoiceControl } from "@/server/voice-control";
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
  return { userId, communityId: c.communityId, sessionId, anchorDeviceId, secret, snapshot,
    auth: { userId, sessionId, memberId: snapshot.memberId, secret }, binding: { callId: snapshot.callId, memberId: snapshot.memberId, joinNonce: snapshot.joinNonce, expectedGeneration: snapshot.generation } };
}

describe("generation room ownership", () => {
  it("does not sign a capability when explicit owned SFU creation fails", async () => {
    const f = await fixture();
    const create = vi.spyOn(RoomServiceClient.prototype, "createRoom").mockRejectedValue(new Error("SFU unavailable"));
    const sign = vi.spyOn(AccessToken.prototype, "toJwt");
    try {
      await expect(createBoundVoiceToken(f.auth, f.binding)).rejects.toMatchObject({ code: "unavailable" });
      expect(create).toHaveBeenCalledWith({ name: `voice:${f.snapshot.channelId}:${f.snapshot.callId}:${f.snapshot.generation}` });
      expect(sign).not.toHaveBeenCalled();
    } finally { create.mockRestore(); sign.mockRestore(); }
  });
});
