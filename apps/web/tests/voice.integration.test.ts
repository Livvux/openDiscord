// Requires a migrated database at DATABASE_URL and LIVEKIT_* settings (a running LiveKit isn't needed).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, createChannel, createCommunity, createInvite, getCommunityView, setChannelOverride } from "@/server/communities";
import { listMessages, sendMessage } from "@/server/messages";
import { listRoles } from "@/server/moderation";
import { Permission } from "@/server/permissions";
import { createVoiceToken, voiceEnabled } from "@/server/voice";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string, outsider: string;
let communityId: string, generalId: string, voiceId: string, everyone: string;

interface VideoClaims {
  sub: string;
  name: string;
  exp: number;
  video: { room: string; roomJoin: boolean; canPublish: boolean; canPublishData: boolean; canPublishSources?: string[] };
}
const claims = async (u: string, channelId: string): Promise<VideoClaims> =>
  JSON.parse(Buffer.from((await createVoiceToken(u, channelId)).token.split(".")[1], "base64url").toString());

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all(["Owner", "Member", "Outsider"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "Voice"));
  await acceptInvite(member, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
  voiceId = await createChannel(owner, communityId, "Lounge", "voice");
  everyone = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
});
afterAll(() => users.cleanup());

describe.runIf(voiceEnabled)("voice channels", () => {
  it("lists voice channels with their kind and keeps them free of messages", async () => {
    expect((await getCommunityView(member, communityId)).channels.find((c) => c.id === voiceId)?.kind).toBe("voice");
    await expect(sendMessage(member, voiceId, "hi")).rejects.toThrow("Voice channels don't have messages.");
    expect(await listMessages(member, voiceId)).toEqual({ messages: [], hasMore: false });
  });

  it("issues a short-lived token for this room only, microphone only, no data channel", async () => {
    const c = await claims(member, voiceId);
    expect(c.sub).toBe(member);
    expect(c.name).toBe("Member");
    expect(c.video).toMatchObject({ room: voiceId, roomJoin: true, canPublish: true, canPublishData: false });
    expect(c.video.canPublishSources).toEqual(["microphone"]);
    expect(c.exp - Date.now() / 1000).toBeLessThanOrEqual(10 * 60 + 5);
  });

  it("enforces Connect and Speak per channel", async () => {
    await setChannelOverride(owner, voiceId, everyone, 0, Permission.Speak);
    expect((await claims(member, voiceId)).video).toMatchObject({ canPublish: false, canPublishSources: [] });
    await setChannelOverride(owner, voiceId, everyone, 0, Permission.Connect);
    await expect(createVoiceToken(member, voiceId)).rejects.toThrow("permission");
    // Owners bypass overrides.
    expect((await claims(owner, voiceId)).video.canPublish).toBe(true);
    await setChannelOverride(owner, voiceId, everyone, 0, 0);
  });

  it("refuses text channels, hidden channels and non-members", async () => {
    await expect(createVoiceToken(member, generalId)).rejects.toThrow("isn't a voice channel");
    await expect(createVoiceToken(outsider, voiceId)).rejects.toThrow("Channel not found.");
    await setChannelOverride(owner, voiceId, everyone, 0, Permission.ViewChannels);
    await expect(createVoiceToken(member, voiceId)).rejects.toThrow("Channel not found.");
    await setChannelOverride(owner, voiceId, everyone, 0, 0);
  });
});
