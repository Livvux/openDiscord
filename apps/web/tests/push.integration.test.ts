// Requires a migrated database at DATABASE_URL and VAPID_* settings.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { pushSubscription } from "@/db/schema";
import { acceptInvite, createChannel, createCommunity, createInvite, setChannelOverride } from "@/server/communities";
import { sendMessage } from "@/server/messages";
import { listRoles } from "@/server/moderation";
import { Permission } from "@/server/permissions";
import { setNotificationLevel } from "@/server/presence";
import { isAllowedEndpoint, pushEnabled, pushMention, savePushSubscription, type PushSender } from "@/server/push";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string;
let communityId: string, generalId: string;
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/test-${n}`, keys: { p256dh: "BPub", auth: "auth" } });

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
  const sent: string[] = [];
  const ok: PushSender = async (s, payload) => (sent.push(`${s.endpoint} ${payload}`), 201);

  beforeAll(async () => {
    [owner, member] = await Promise.all(["Owner", "Member"].map(users.create));
    ({ communityId, channelId: generalId } = await createCommunity(owner, "Pushy"));
    await acceptInvite(member, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
    await savePushSubscription(member, sub(1));
  });
  afterAll(() => users.cleanup());

  it("refuses unsupported endpoints", async () => {
    await expect(savePushSubscription(member, { ...sub(2), endpoint: "https://evil.test/x" })).rejects.toThrow("isn't supported");
  });

  it("pushes a short, readable payload for a visible channel", async () => {
    const msg = await sendMessage(owner, generalId, `hey <@${member}> look`);
    expect(await pushMention(member, generalId, msg.id, ok)).toBe(1);
    const payload = JSON.parse(sent.at(-1)!.split(" ").slice(1).join(" "));
    expect(payload).toMatchObject({ title: "Owner in #general", body: "hey @Member look", url: `/app/c/${communityId}/${generalId}` });
  });

  it("skips muted communities and channels the person can't read", async () => {
    const msg = await sendMessage(owner, generalId, `again <@${member}>`);
    await setNotificationLevel(member, communityId, "muted");
    expect(await pushMention(member, generalId, msg.id, ok)).toBe(0);
    await setNotificationLevel(member, communityId, "mentions");
    const hidden = await createChannel(owner, communityId, "hidden");
    const everyone = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
    await setChannelOverride(owner, hidden, everyone, 0, Permission.ViewChannels);
    const secret = await sendMessage(owner, hidden, `secret <@${member}>`);
    expect(await pushMention(member, hidden, secret.id, ok)).toBe(0);
  });

  it("forgets subscriptions the push service reports as gone", async () => {
    const msg = await sendMessage(owner, generalId, `last <@${member}>`);
    expect(await pushMention(member, generalId, msg.id, async () => 410)).toBe(0);
    expect(await db.select().from(pushSubscription).where(eq(pushSubscription.userId, member))).toEqual([]);
  });
});
