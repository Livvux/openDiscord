// Regression tests for the security review findings. Requires a migrated database at DATABASE_URL.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLog, channel, community, role, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { acceptInvite, createChannel, createCommunity, createInvite } from "@/server/communities";
import { CAPS, consume } from "@/server/limits";
import { editMessage, sendMessage } from "@/server/messages";
import { banMember, createRole, kickMember, setMemberRole, unbanMember, updateRole } from "@/server/moderation";
import { GET as events } from "@/app/api/communities/[communityId]/events/route";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, mod: string, member: string, target: string;
let communityId: string, channelId: string;

async function join(userId: string) {
  await acceptInvite(userId, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: null }));
}

beforeAll(async () => {
  [owner, mod, member, target] = await Promise.all(["Owner", "Mod", "Member", "Target"].map(users.create));
  ({ communityId, channelId } = await createCommunity(owner, "Hardening"));
  await Promise.all([mod, member, target].map(join));
});
afterAll(() => users.cleanup());

describe("unban hierarchy", () => {
  it("stops a lower-ranked moderator from lifting a ban issued above them", async () => {
    const banner = await createRole(owner, communityId, "Banner", ["BanMembers"]);
    await setMemberRole(owner, banner, mod, true);

    await banMember(owner, communityId, target, "owner ban");
    await expect(unbanMember(mod, communityId, target)).rejects.toMatchObject({ code: "forbidden" });
    await unbanMember(owner, communityId, target);
  });

  it("lets moderators lift their own bans", async () => {
    await join(target);
    await banMember(mod, communityId, target);
    await unbanMember(mod, communityId, target);
  });
});

describe("muted members", () => {
  it("can't edit their messages after losing SendMessages", async () => {
    const sent = await sendMessage(member, channelId, "before mute");
    const [defaultRole] = await db.select().from(role).where(eq(role.communityId, communityId)).then((r) => r.filter((x) => x.isDefault));
    await updateRole(owner, defaultRole.id, "everyone", ["ViewChannels", "CreateInvites"]);
    await expect(editMessage(member, sent.id, "rewritten")).rejects.toMatchObject({ code: "forbidden" });
    await updateRole(owner, defaultRole.id, "everyone", ["ViewChannels", "CreateInvites", "SendMessages"]);
  });
});

describe("caps", () => {
  it("bounds channels per community", async () => {
    const { communityId: full } = await createCommunity(owner, "Full");
    await db.insert(channel).values(Array.from({ length: CAPS.channelsPerCommunity - 1 }, (_, i) => ({ communityId: full, name: `c${i}` })));
    await expect(createChannel(owner, full, "one-too-many")).rejects.toMatchObject({ code: "conflict" });
  });

  it("limits bursts of mutations", async () => {
    const key = `test:${randomUUID()}`;
    for (let i = 0; i < 3; i++) await consume(key, 3, 1000, 10_000 + i);
    await expect(consume(key, 3, 1000, 10_500)).rejects.toThrow(/too often/);
    await expect(consume(key, 3, 1000, 12_000)).resolves.toBeUndefined();
  });
});

describe("realtime stream access", () => {
  async function headersFor(email: string) {
    const res = await auth.api.signUpEmail({ body: { email, password: "correct horse battery", name: "Streamer" }, returnHeaders: true });
    return { id: res.response.user.id, headers: new Headers({ cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] }) };
  }
  const ctx = (id: string) => ({ params: Promise.resolve({ communityId: id }) });

  it("refuses non-members and caps concurrent streams per user", async () => {
    const email = `stream-${randomUUID()}@example.test`;
    const streamer = await headersFor(email);
    try {
      const outsider = await events(new Request("http://localhost/x", { headers: streamer.headers }), ctx(communityId));
      expect(outsider.status).toBe(404);

      const { communityId: own } = await createCommunity(streamer.id, "Mine");
      const controllers: AbortController[] = [];
      const statuses: number[] = [];
      for (let i = 0; i < 9; i++) {
        const c = new AbortController();
        controllers.push(c);
        const res = await events(new Request("http://localhost/x", { headers: streamer.headers, signal: c.signal }), ctx(own));
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 8).every((s) => s === 200)).toBe(true);
      expect(statuses[8]).toBe(429);
      controllers.forEach((c) => c.abort());
      await new Promise((r) => setTimeout(r, 50));
      const again = await events(new Request("http://localhost/x", { headers: streamer.headers }), ctx(own));
      expect(again.status).toBe(200);
      await again.body?.cancel();
    } finally {
      await db.delete(community).where(eq(community.ownerId, streamer.id));
      await db.delete(user).where(eq(user.email, email));
    }
  });
});

describe("erasure", () => {
  it("unlinks audit entries about a deleted account", async () => {
    const email = `gone-${randomUUID()}@example.test`;
    const res = await auth.api.signUpEmail({ body: { email, password: "correct horse battery", name: "Gone" }, returnHeaders: true });
    const gone = res.response.user.id;
    await join(gone);
    await kickMember(owner, communityId, gone, "bye");
    await auth.api.deleteUser({
      body: { password: "correct horse battery" },
      headers: new Headers({ cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] }),
    });
    expect(await db.select().from(auditLog).where(eq(auditLog.targetId, gone))).toEqual([]);
  });
});
