// Requires a migrated database at DATABASE_URL and VAPID_* settings.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { message, pushSubscription } from "@/db/schema";
import { acceptInvite, createChannel, createCommunity, createInvite, setChannelOverride } from "@/server/communities";
import { listRoles } from "@/server/moderation";
import { Permission } from "@/server/permissions";
import { setNotificationLevel, setPresenceStatus } from "@/server/presence";
import { isAllowedEndpoint, pushDirectMessage, pushEnabled, pushMention, savePushSubscription, type PushSender } from "@/server/push";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string;
let communityId: string, generalId: string;
// Real-looking key material (base64url lengths of a P-256 key and a 16-byte secret).
const sub = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/test-${n}`,
  keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) },
});

describe("push endpoints", () => {
  it("accept only well-known push services over HTTPS", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) {
      expect(isAllowedEndpoint(ok)).toBe(true);
    }
    for (const bad of ["http://fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://localhost/x", "https://fcm.googleapis.com.evil.test/x", "https://fcm.googleapis.com:8443/x", "not a url"]) {
      expect(isAllowedEndpoint(bad)).toBe(false);
    }
  });
});

describe.runIf(pushEnabled)("mention pushes", () => {
  // Inserted directly: sendMessage would also push through the real transport (with fake keys).
  const post = async (channelId: string, content: string) =>
    (await db.insert(message).values({ channelId, authorId: owner, content }).returning())[0];
  const sent: string[] = [];
  const ok: PushSender = async (s, payload) => (sent.push(`${s.endpoint} ${payload}`), 201);

  beforeAll(async () => {
    [owner, member] = await Promise.all(["Owner", "Member"].map(users.create));
    ({ communityId, channelId: generalId } = await createCommunity(owner, "Pushy"));
    await acceptInvite(member, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
    await savePushSubscription(member, sub(1));
  });
  afterAll(() => users.cleanup());

  it("refuses unsupported endpoints and malformed keys; re-registering doesn't count twice", async () => {
    await expect(savePushSubscription(member, { ...sub(2), endpoint: "https://evil.test/x" })).rejects.toThrow("isn't supported");
    await expect(savePushSubscription(member, { ...sub(2), keys: { p256dh: "short", auth: "x" } })).rejects.toThrow();
    await savePushSubscription(member, sub(1));
    expect(await db.$count(pushSubscription, eq(pushSubscription.userId, member))).toBe(1);
  });

  it("pushes a short, readable payload for a visible channel", async () => {
    const msg = await post(generalId, `hey <@${member}> look`);
    expect(await pushMention(member, generalId, msg.id, ok)).toBe(1);
    const payload = JSON.parse(sent.at(-1)!.split(" ").slice(1).join(" "));
    // Not stored as a mention row (inserted directly), so the token renders as "@member".
    expect(payload).toMatchObject({ title: "Owner in #general", body: "hey @member look", url: `/app/c/${communityId}/${generalId}` });
  });

  it("announces a private message by sender only, never its content, and respects Do not disturb", async () => {
    expect(await pushDirectMessage(member, owner, ok)).toBe(1);
    const payload = JSON.parse(sent.at(-1)!.split(" ").slice(1).join(" "));
    expect(payload).toEqual({ title: "Owner", body: "New encrypted message", url: `/app/messages?to=${encodeURIComponent(owner)}`, tag: `dm:${owner}` });
    // A group message opens the group; still content-free.
    const group = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(await pushDirectMessage(member, owner, ok, group)).toBe(1);
    expect(JSON.parse(sent.at(-1)!.split(" ").slice(1).join(" "))).toEqual({ title: "Owner", body: "New encrypted message", url: `/app/messages?c=${group}`, tag: `dm:${group}` });
    await setPresenceStatus(member, "dnd");
    expect(await pushDirectMessage(member, owner, ok)).toBe(0);
    await setPresenceStatus(member, "online");
  });

  it("skips muted communities and channels the person can't read", async () => {
    const msg = await post(generalId, `again <@${member}>`);
    await setNotificationLevel(member, communityId, "muted");
    expect(await pushMention(member, generalId, msg.id, ok)).toBe(0);
    await setNotificationLevel(member, communityId, "mentions");
    const hidden = await createChannel(owner, communityId, "hidden");
    const everyone = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
    await setChannelOverride(owner, hidden, everyone, 0, Permission.ViewChannels);
    const secret = await post(hidden, `secret <@${member}>`);
    expect(await pushMention(member, hidden, secret.id, ok)).toBe(0);
  });

  it("drops subscriptions whose keys can't be used", async () => {
    await savePushSubscription(member, sub(3));
    const msg = await post(generalId, `keys <@${member}>`);
    const broken: PushSender = async (s) => {
      if (s.endpoint.endsWith("test-3")) throw new Error("invalid key");
      return 201;
    };
    expect(await pushMention(member, generalId, msg.id, broken)).toBe(1);
    // A network failure keeps the subscription.
    const offline: PushSender = async () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); };
    expect(await pushMention(member, generalId, msg.id, offline)).toBe(0);
    expect((await db.select().from(pushSubscription).where(eq(pushSubscription.userId, member))).map((s) => s.endpoint)).toEqual([sub(1).endpoint]);
  });

  it("forgets subscriptions the push service reports as gone", async () => {
    const msg = await post(generalId, `last <@${member}>`);
    expect(await pushMention(member, generalId, msg.id, async () => 410)).toBe(0);
    expect(await db.select().from(pushSubscription).where(eq(pushSubscription.userId, member))).toEqual([]);
  });
});
