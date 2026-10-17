// Requires a migrated database at DATABASE_URL and LIVEKIT_* settings (a running LiveKit isn't needed).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, createChannel, createCommunity, createInvite, getCommunityView } from "@/server/communities";
import { listMessages, sendMessage } from "@/server/messages";
import { voiceEnabled } from "@/server/voice";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string;
let communityId: string, voiceId: string;
beforeAll(async () => {
  [owner, member] = await Promise.all(["Owner", "Member"].map(users.create));
  ({ communityId } = await createCommunity(owner, "Voice"));
  await acceptInvite(member, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
  voiceId = await createChannel(owner, communityId, "Lounge", "voice");
});
afterAll(() => users.cleanup());
describe.runIf(voiceEnabled)("voice channels", () => {
  it("lists voice channels with their kind and keeps them free of messages", async () => {
    expect((await getCommunityView(member, communityId)).channels.find((c) => c.id === voiceId)?.kind).toBe("voice");
    await expect(sendMessage(member, voiceId, "hi")).rejects.toThrow("Voice channels don't have messages.");
    expect(await listMessages(member, voiceId)).toEqual({ messages: [], hasMore: false });
  });
  // Bound issuer authorization/source/token checks live in voice-product-boundaries and lifecycle integration suites.
});
