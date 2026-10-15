// Requires a migrated database at DATABASE_URL.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { member, message, session, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { createCommunity, deleteCommunity } from "@/server/communities";
import { sendMessage } from "@/server/messages";
import { hub, type HubEvent } from "@/server/realtime";
import { testUsers } from "./helpers";

const users = testUsers();
afterAll(() => users.cleanup());

describe("realtime hub", () => {
  it("delivers published events to subscribers of that community only", async () => {
    const owner = await users.create("Realtime");
    const { communityId, channelId } = await createCommunity(owner, "Live");
    const other = randomUUID();
    const received: HubEvent[] = [];
    const leaked: HubEvent[] = [];
    const unsubscribe = hub.subscribe(communityId, (e) => received.push(e));
    const unsubscribeOther = hub.subscribe(other, (e) => leaked.push(e));
    // Give the LISTEN connection a moment to come up.
    await new Promise((r) => setTimeout(r, 300));

    const sent = await sendMessage(owner, channelId, "ping");
    await expect.poll(() => received.map((e) => e.type)).toContain("message.created");
    expect(received.find((e) => e.type === "message.created")).toMatchObject({ channelId, messageId: sent.id });
    expect(leaked).toEqual([]);
    unsubscribe();
    unsubscribeOther();
  });
});

describe("account deletion", () => {
  const email = `delete-${randomUUID()}@example.test`;
  const password = "correct horse battery";

  async function signUp() {
    const res = await auth.api.signUpEmail({ body: { email, password, name: "Leaving" }, returnHeaders: true });
    const cookie = res.headers.get("set-cookie") ?? "";
    return { userId: res.response.user.id, headers: new Headers({ cookie: cookie.split(";")[0] }) };
  }

  it("does not store IP addresses with sessions", async () => {
    const { userId } = await signUp();
    const rows = await db.select().from(session).where(eq(session.userId, userId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ipAddress === null)).toBe(true);
    await db.delete(user).where(eq(user.id, userId));
  });

  it("refuses while the person owns a community, then erases their data", async () => {
    const { userId, headers } = await signUp();
    const { communityId, channelId } = await createCommunity(userId, "Owned");
    await sendMessage(userId, channelId, "bye");

    await expect(auth.api.deleteUser({ body: { password }, headers })).rejects.toThrow(/Delete the communities you own first/);

    await deleteCommunity(userId, communityId);
    // A community they only joined keeps existing; their messages there are erased.
    const host = await users.create("Host");
    const shared = await createCommunity(host, "Shared");
    await db.insert(member).values({ communityId: shared.communityId, userId });
    await sendMessage(userId, shared.channelId, "my message");

    await auth.api.deleteUser({ body: { password }, headers });
    expect(await db.select().from(user).where(eq(user.id, userId))).toEqual([]);
    expect(await db.select().from(message).where(eq(message.authorId, userId))).toEqual([]);
  });
});
