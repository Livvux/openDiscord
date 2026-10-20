import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { friendship, session, userSuspension } from "@/db/schema";
import { voiceCall, voiceCallMember, voiceSfuRoom } from "@/db/voice-schema";
import { blockUser } from "@/server/blocks";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { createDirectConversation, registerDmDevice } from "@/server/direct-messages";
import { createGroupConversation, leaveGroup, removeGroupMember } from "@/server/dm-groups";
import { hub, userTopic, type HubEvent } from "@/server/realtime";
import { grantBoundVoiceMedia, heartbeatVoiceControl, invalidateVoiceMembership, joinVoiceControl, leaveVoiceControl, sweepVoiceLifecycle } from "@/server/voice-control";
import type { VoiceSnapshot } from "@/lib/voice/contracts";
import { testUsers } from "./helpers";

const users = testUsers();
type Account = { userId: string; sessionId: string; anchorDeviceId: string; anchorSecret: string };
type Endpoint = Account & { secret: string; snapshot: VoiceSnapshot };
const people: Record<string, Account> = {};
const befriend = (a: string, b: string) => db.insert(friendship).values({ firstId: [a, b].sort()[0], secondId: [a, b].sort()[1], requestedBy: a, status: "accepted" });
const memberAuth = (e: Endpoint) => ({ userId: e.userId, sessionId: e.sessionId, memberId: e.snapshot.memberId, secret: e.secret });
const binding = (e: Endpoint) => ({ callId: e.snapshot.callId, memberId: e.snapshot.memberId, joinNonce: e.snapshot.joinNonce, expectedGeneration: e.snapshot.generation });
const heartbeat = async (e: Endpoint) => (e.snapshot = await heartbeatVoiceControl(memberAuth(e), binding(e)));
const memberState = async (e: Endpoint) => (await db.select({ state: voiceCallMember.state }).from(voiceCallMember).where(eq(voiceCallMember.id, e.snapshot.memberId)))[0]?.state;

async function account(name: string): Promise<Account> {
  const userId = await users.create(`Call ${name}`), sessionId = randomUUID(), anchorDeviceId = randomUUID(), anchorSecret = randomBytes(32).toString("hex");
  await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Call anchor" });
  return { userId, sessionId, anchorDeviceId, anchorSecret };
}
async function join(a: Account, conversationId: string): Promise<Endpoint> {
  const secret = randomBytes(32).toString("hex");
  const snapshot = await joinVoiceControl(a, { conversationId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: secret, consent: true });
  return { ...a, secret, snapshot };
}
async function leaveAll(...endpoints: Endpoint[]) {
  for (const e of endpoints) { await heartbeat(e).catch(() => {}); await leaveVoiceControl(memberAuth(e), binding(e)).catch(() => {}); }
}
function listen(userId: string) {
  const events: HubEvent[] = [];
  const stop = hub.subscribe(userTopic(userId), (e) => events.push(e));
  return { events, stop, calls: () => events.filter((e) => e.type === "dm.call") };
}

beforeAll(async () => {
  for (const name of ["Ada", "Ben", "Cy", "Dee", "Eve", "Stranger", "Pending"]) people[name] = await account(name);
  for (const name of ["Ben", "Cy", "Dee", "Eve"]) await befriend(people.Ada.userId, people[name].userId);
  await befriend(people.Ben.userId, people.Cy.userId);
  // Pending shares a community with Ada but is no friend, so their conversation starts as a request.
  const c = await createCommunity(people.Ada.userId, "Call requests");
  await acceptInvite(people.Pending.userId, await createInvite(people.Ada.userId, c.communityId, { expiresInHours: 24, maxUses: null }));
});
afterAll(() => users.cleanup());

describe("direct message call authorization", () => {
  it("lets both participants of an accepted 1:1 conversation join one call with full media grants", async () => {
    const { Ada, Ben } = people;
    const conversationId = await createDirectConversation(Ada.userId, Ben.userId);
    const ada = await join(Ada, conversationId);
    expect(ada.snapshot).toMatchObject({ conversationId, generation: 1 });
    expect(ada.snapshot).not.toHaveProperty("channelId");
    const ben = await join(Ben, conversationId);
    expect(ben.snapshot.callId).toBe(ada.snapshot.callId);
    await heartbeat(ada);
    expect(ada.snapshot.members.map((m) => m.userId).sort()).toEqual([Ada.userId, Ben.userId].sort());
    const grant = await grantBoundVoiceMedia(memberAuth(ben), binding(ben));
    expect(grant.sources).toEqual(["microphone", "camera", "screen_share", "screen_share_audio"]);
    // The SFU only learns the random call id, never the conversation id.
    expect(grant.roomName).toBe(`voice:${ben.snapshot.callId}:${ben.snapshot.callId}:${ben.snapshot.generation}`);
    expect(grant.roomName).not.toContain(conversationId);
    const [room] = await db.select().from(voiceSfuRoom).where(eq(voiceSfuRoom.roomName, grant.roomName));
    expect(room).toMatchObject({ callId: ben.snapshot.callId, status: "active" });
    await leaveAll(ada, ben);
  });

  it("refuses strangers, pending requests and a join naming both a channel and a conversation", async () => {
    const { Ada, Ben, Stranger, Pending } = people;
    const conversationId = await createDirectConversation(Ada.userId, Ben.userId);
    await expect(join(Stranger, conversationId)).rejects.toMatchObject({ code: "not_found" });
    await expect(join(Stranger, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    // Not friends: this stays a pending request, which cannot be called.
    const pending = await createDirectConversation(Pending.userId, Ada.userId);
    await expect(join(Pending, pending)).rejects.toMatchObject({ code: "forbidden" });
    await expect(join(Ada, pending)).rejects.toMatchObject({ code: "forbidden" });
    await expect(joinVoiceControl(Ada, { channelId: randomUUID(), conversationId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: randomBytes(32).toString("hex"), consent: true })).rejects.toMatchObject({ code: "invalid" });
  });

  it("ends a 1:1 call on a block and refuses calls between blocked people", async () => {
    const { Ada, Dee } = people;
    const conversationId = await createDirectConversation(Ada.userId, Dee.userId);
    const ada = await join(Ada, conversationId), dee = await join(Dee, conversationId);
    await blockUser(Dee.userId, Ada.userId);
    expect(await memberState(ada)).toBe("left");
    expect(await memberState(dee)).toBe("left");
    await expect(heartbeat(ada)).rejects.toMatchObject({ code: "forbidden" });
    await expect(grantBoundVoiceMedia(memberAuth(dee), binding(dee))).rejects.toMatchObject({ code: "forbidden" });
    await expect(join(Ada, conversationId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(join(Dee, conversationId)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("revokes a group member who leaves or is removed, immediately and for every later request", async () => {
    const { Ada, Ben, Cy, Eve } = people;
    const group = await createGroupConversation(Ada.userId, { members: [Ben.userId, Cy.userId, Eve.userId] });
    const ada = await join(Ada, group), ben = await join(Ben, group), cy = await join(Cy, group), eve = await join(Eve, group);
    await heartbeat(ada);
    const generation = ada.snapshot.generation;
    await removeGroupMember(Ada.userId, group, Ben.userId);
    expect(await memberState(ben)).toBe("left");
    await expect(heartbeat(ben)).rejects.toMatchObject({ code: "forbidden" });
    await expect(grantBoundVoiceMedia(memberAuth(ben), binding(ben))).rejects.toMatchObject({ code: "forbidden" });
    await expect(join(Ben, group)).rejects.toMatchObject({ code: "not_found" });
    // Remaining members move to a new generation (fresh room and keys) without Ben.
    await heartbeat(ada);
    expect(ada.snapshot.generation).toBeGreaterThan(generation);
    expect(ada.snapshot.members.map((m) => m.userId)).not.toContain(Ben.userId);
    await leaveGroup(Cy.userId, group);
    expect(await memberState(cy)).toBe("left");
    await expect(heartbeat(cy)).rejects.toMatchObject({ code: "forbidden" });
    await heartbeat(eve);
    expect(eve.snapshot.members.map((m) => m.userId).sort()).toEqual([Ada.userId, Eve.userId].sort());
    await leaveAll(ada, eve);
  });

  it("refuses a suspended account and drops a suspended member at the next check", async () => {
    const { Ada, Cy } = people;
    const conversationId = await createDirectConversation(Ada.userId, Cy.userId);
    const ada = await join(Ada, conversationId), cy = await join(Cy, conversationId);
    await db.insert(userSuspension).values({ userId: Cy.userId, reason: "test" });
    try {
      await db.transaction((tx) => invalidateVoiceMembership(tx, { userId: Cy.userId }, "account-suspended"));
      expect(await memberState(cy)).toBe("left");
      await expect(join(Cy, conversationId)).rejects.toMatchObject({ code: "forbidden" });
      // 1:1 calls follow the messaging rule: a suspended peer ends the conversation's call.
      await expect(heartbeat(ada)).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await db.delete(userSuspension).where(eq(userSuspension.userId, Cy.userId));
    }
  });

  it("rings other members content-free when a call starts and announces its end", async () => {
    const { Ada, Ben, Dee, Eve } = people;
    const ben = listen(Ben.userId), eve = listen(Eve.userId), dee = listen(Dee.userId);
    await new Promise((r) => setTimeout(r, 300));
    try {
      const group = await createGroupConversation(Ada.userId, { members: [Ben.userId, Eve.userId] });
      const ada = await join(Ada, group);
      await expect.poll(() => ben.calls()).toEqual([{ type: "dm.call", userId: Ben.userId, conversationId: group, callerId: Ada.userId, state: "ringing" }]);
      await expect.poll(() => eve.calls().length).toBe(1);
      const benCall = await join(Ben, group);
      await new Promise((r) => setTimeout(r, 200));
      // Joining an existing call does not ring again; it only clears Ben's other sessions.
      expect(ben.calls().map((e) => e.type === "dm.call" && e.state)).toEqual(["ringing", "cleared"]);
      await leaveAll(benCall, ada);
      await expect.poll(() => eve.calls().map((e) => e.type === "dm.call" && e.state)).toEqual(["ringing", "ended"]);
      expect(dee.calls()).toEqual([]);
    } finally { ben.stop(); eve.stop(); dee.stop(); }
  });

  it("does not ring a member who has a block with the caller", async () => {
    const { Ada, Ben, Cy } = people;
    const group = await createGroupConversation(Ada.userId, { members: [Ben.userId, Cy.userId] });
    await blockUser(Cy.userId, Ben.userId);
    const cy = listen(Cy.userId), ada = listen(Ada.userId);
    await new Promise((r) => setTimeout(r, 300));
    try {
      const ben = await join(Ben, group);
      await expect.poll(() => ada.calls().length).toBe(1);
      expect(cy.calls()).toEqual([]);
      await expect(join(Cy, group)).rejects.toMatchObject({ code: "forbidden" });
      await leaveAll(ben);
    } finally { cy.stop(); ada.stop(); }
  });

  it("reaps expired DM calls in the maintenance sweep", async () => {
    const { Ada, Eve } = people;
    const conversationId = await createDirectConversation(Ada.userId, Eve.userId);
    const ada = await join(Ada, conversationId);
    await db.update(voiceCallMember).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(voiceCallMember.id, ada.snapshot.memberId));
    await sweepVoiceLifecycle({ apply: true, now: new Date(), batchSize: 8, maxBatches: 4 });
    const [call] = await db.select().from(voiceCall).where(eq(voiceCall.id, ada.snapshot.callId));
    expect(call.status).toBe("closed");
  });
});
