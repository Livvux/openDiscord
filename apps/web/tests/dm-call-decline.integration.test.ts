// Declining a direct-message call: only a rung current member may decline; their other sessions stop ringing and
// people in the call learn who declined (ids only). Requires a migrated database at DATABASE_URL.
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { friendship, session, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { POST } from "@/app/api/dm/route";
import { blockUser } from "@/server/blocks";
import { createDirectConversation, registerDmDevice } from "@/server/direct-messages";
import { createGroupConversation, leaveGroup } from "@/server/dm-groups";
import { hub, userTopic, type HubEvent } from "@/server/realtime";
import { declineDmCall, heartbeatVoiceControl, joinVoiceControl, leaveVoiceControl } from "@/server/voice-control";
import type { VoiceSnapshot } from "@/lib/voice/contracts";
import { REGISTRATION_HEADERS, testUsers } from "./helpers";

const users = testUsers();
const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin;
type Account = { userId: string; sessionId: string; anchorDeviceId: string; anchorSecret: string };
type Endpoint = Account & { secret: string; snapshot: VoiceSnapshot };
const people: Record<string, Account> = {};
let routeUser: { userId: string; cookie: string }, deeConversation: string;
const befriend = (a: string, b: string) => db.insert(friendship).values({ firstId: [a, b].sort()[0], secondId: [a, b].sort()[1], requestedBy: a, status: "accepted" });
const settle = () => new Promise((r) => setTimeout(r, 300));

async function account(name: string, userId?: string): Promise<Account> {
  const id = userId ?? await users.create(`Decline ${name}`), sessionId = randomUUID(), anchorDeviceId = randomUUID(), anchorSecret = randomBytes(32).toString("hex");
  await db.insert(session).values({ id: sessionId, userId: id, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  await registerDmDevice(id, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Call anchor" });
  return { userId: id, sessionId, anchorDeviceId, anchorSecret };
}
async function join(a: Account, conversationId: string): Promise<Endpoint> {
  const secret = randomBytes(32).toString("hex");
  return { ...a, secret, snapshot: await joinVoiceControl(a, { conversationId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: secret, consent: true }) };
}
async function leave(...endpoints: Endpoint[]) {
  for (const e of endpoints) {
    const memberAuth = { userId: e.userId, sessionId: e.sessionId, memberId: e.snapshot.memberId, secret: e.secret };
    const binding = () => ({ callId: e.snapshot.callId, memberId: e.snapshot.memberId, joinNonce: e.snapshot.joinNonce, expectedGeneration: e.snapshot.generation });
    e.snapshot = await heartbeatVoiceControl(memberAuth, binding()).catch(() => e.snapshot);
    await leaveVoiceControl(memberAuth, binding()).catch(() => {});
  }
}
function listen(userId: string) {
  const events: HubEvent[] = [];
  const stop = hub.subscribe(userTopic(userId), (e) => events.push(e));
  return { stop, calls: () => events.filter((e) => e.type === "dm.call") };
}
const decline = (cookie: string, from: string, id: string) =>
  POST(new Request(`${origin}/api/dm`, { method: "POST", headers: { cookie, origin: from, "content-type": "application/json" }, body: JSON.stringify({ action: "call-decline", id }) }));

beforeAll(async () => {
  const signed = await auth.api.signUpEmail({ headers: REGISTRATION_HEADERS, body: { email: `decline-${randomUUID()}@example.test`, name: "Decline Ben", password: `Pw-${randomUUID()}` }, returnHeaders: true });
  routeUser = { userId: signed.response.user.id, cookie: (signed.headers.get("set-cookie") ?? "").split(";")[0] };
  for (const name of ["Ada", "Cy", "Dee", "Eve", "Fay", "Stranger"]) people[name] = await account(name);
  people.Ben = await account("Ben", routeUser.userId);
  for (const name of ["Ben", "Cy", "Dee", "Eve", "Fay"]) await befriend(people.Ada.userId, people[name].userId);
  // Opened before Dee blocks Ada below.
  deeConversation = await createDirectConversation(people.Ada.userId, people.Dee.userId);
});
afterAll(async () => {
  await users.cleanup();
  await db.delete(user).where(eq(user.id, routeUser.userId));
});

describe("declining a direct-message call", () => {
  it("stops the decliner's other sessions and tells the caller who declined, through the same-origin route only", async () => {
    const { Ada, Ben } = people;
    const conversationId = await createDirectConversation(Ada.userId, Ben.userId);
    const ada = listen(Ada.userId), ben = listen(Ben.userId);
    await settle();
    try {
      const call = await join(Ada, conversationId);
      await expect.poll(() => ben.calls().map((e) => e.type === "dm.call" && e.state)).toEqual(["ringing"]);
      expect((await decline(routeUser.cookie, "https://evil.example", conversationId)).status).toBe(403);
      await settle();
      expect(ada.calls()).toEqual([]);
      expect((await decline(routeUser.cookie, origin, conversationId)).status).toBe(200);
      await expect.poll(() => ben.calls().at(-1)).toEqual({ type: "dm.call", userId: Ben.userId, conversationId, state: "cleared" });
      await expect.poll(() => ada.calls()).toEqual([{ type: "dm.call", userId: Ada.userId, conversationId, state: "declined", callerId: Ben.userId }]);
      // Malformed ids are refused at the boundary.
      expect((await decline(routeUser.cookie, origin, "not-a-uuid")).status).toBe(400);
      await leave(call);
    } finally { ada.stop(); ben.stop(); }
  });

  it("clears the other sessions of a person who answers on one device", async () => {
    const { Ada, Cy } = people;
    const conversationId = await createDirectConversation(Ada.userId, Cy.userId);
    const cy = listen(Cy.userId);
    await settle();
    try {
      const call = await join(Ada, conversationId);
      await expect.poll(() => cy.calls().length).toBe(1);
      const answer = await join(Cy, conversationId);
      await expect.poll(() => cy.calls().map((e) => e.type === "dm.call" && e.state)).toEqual(["ringing", "cleared"]);
      // Someone already in the call has nothing to decline.
      await expect(declineDmCall(Cy.userId, conversationId)).rejects.toMatchObject({ code: "not_found" });
      await leave(answer, call);
    } finally { cy.stop(); }
  });

  it("refuses non-members, people who were not rung, left members and blocked people", async () => {
    const { Ada, Cy, Dee, Eve, Stranger } = people;
    const group = await createGroupConversation(Ada.userId, { members: [Cy.userId, Dee.userId, Eve.userId] });
    await blockUser(Dee.userId, Ada.userId);
    await leaveGroup(Eve.userId, group);
    const ada = listen(Ada.userId);
    await settle();
    try {
      // No call yet: nobody was rung.
      await expect(declineDmCall(Cy.userId, group)).rejects.toMatchObject({ code: "not_found" });
      const call = await join(Ada, group);
      await expect(declineDmCall(Stranger.userId, group)).rejects.toMatchObject({ code: "not_found" });
      await expect(declineDmCall(Ada.userId, group)).rejects.toMatchObject({ code: "not_found" });
      await expect(declineDmCall(Eve.userId, group)).rejects.toMatchObject({ code: "not_found" });
      await expect(declineDmCall(Dee.userId, group)).rejects.toMatchObject({ code: "forbidden" });
      await expect(declineDmCall(Cy.userId, randomUUID())).rejects.toMatchObject({ code: "not_found" });
      await expect(declineDmCall(Cy.userId, "x")).rejects.toMatchObject({ code: "invalid" });
      await settle();
      expect(ada.calls()).toEqual([]);
      await declineDmCall(Cy.userId, group);
      await expect.poll(() => ada.calls()).toEqual([{ type: "dm.call", userId: Ada.userId, conversationId: group, state: "declined", callerId: Cy.userId }]);
      await leave(call);
    } finally { ada.stop(); }
  });

  it("refuses a blocked 1:1 peer and rate limits declines", async () => {
    const { Ada, Fay, Dee } = people;
    await expect(declineDmCall(Dee.userId, deeConversation)).rejects.toMatchObject({ code: "forbidden" });
    const conversationId = await createDirectConversation(Ada.userId, Fay.userId);
    const call = await join(Ada, conversationId);
    for (let i = 0; i < 20; i++) await declineDmCall(Fay.userId, conversationId);
    await expect(declineDmCall(Fay.userId, conversationId)).rejects.toMatchObject({ code: "rate_limited" });
    await leave(call);
  });
});
