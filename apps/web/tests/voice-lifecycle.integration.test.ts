import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { channel, session } from "@/db/schema";
import { voiceCall, voiceCallMember } from "@/db/voice-schema";
import { createCommunity } from "@/server/communities";
import { registerDmDevice } from "@/server/direct-messages";
import { joinVoiceControl } from "@/server/voice-control";
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
  return { sessionId, snapshot };
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
