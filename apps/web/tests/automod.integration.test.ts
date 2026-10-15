// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAutomod, updateAutomod } from "@/server/automod";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { editMessage, sendMessage } from "@/server/messages";
import { createRole, listAuditLog, setMemberRole } from "@/server/moderation";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string, mod: string;
let communityId: string, generalId: string;

beforeAll(async () => {
  [owner, member, mod] = await Promise.all(["Owner", "Member", "Mod"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "Filtered"));
  for (const u of [member, mod]) await acceptInvite(u, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
  await setMemberRole(owner, await createRole(owner, communityId, "mods", ["ManageMessages", "SendMessages", "ViewChannels"]), mod, true);
});
afterAll(() => users.cleanup());

describe("AutoMod", () => {
  it("is managed by community managers only, with normalised, de-duplicated words", async () => {
    await expect(updateAutomod(member, communityId, { words: ["x"], blockLinks: false })).rejects.toThrow("permission");
    await updateAutomod(owner, communityId, { words: [" Scam ", "scam", "FREE NITRO"], blockLinks: true });
    expect(await getAutomod(owner, communityId)).toEqual({ words: ["scam", "free nitro"], blockLinks: true });
    await expect(updateAutomod(owner, communityId, { words: Array.from({ length: 101 }, (_, i) => `w${i}`), blockLinks: false })).rejects.toThrow("at most 100");
  });

  it("refuses matching messages and edits, audited without content; moderators are exempt", async () => {
    await expect(sendMessage(member, generalId, "get FREE nitro now")).rejects.toThrow("blocked word");
    await expect(sendMessage(member, generalId, "https://phish.test")).rejects.toThrow("links");
    const ok = await sendMessage(member, generalId, "hello");
    await expect(editMessage(member, ok.id, "total scam")).rejects.toThrow("blocked word");
    await expect(sendMessage(mod, generalId, "warning: scam links like https://phish.test")).resolves.toBeDefined();
    const blocks = (await listAuditLog(owner, communityId)).filter((e) => e.action === "automod.block");
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.every((e) => e.reason === "blocked word" || e.reason === "link")).toBe(true);
  });

  it("caps audit entries per person per minute", async () => {
    for (let i = 0; i < 6; i++) await expect(sendMessage(member, generalId, "scam")).rejects.toThrow();
    const mine = (await listAuditLog(owner, communityId)).filter((e) => e.action === "automod.block" && e.actorName === "Member");
    expect(mine.length).toBeLessThanOrEqual(3);
  });
});
