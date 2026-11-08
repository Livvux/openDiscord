// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { loadChannelAuthority } from "@/server/access";
import { acceptInvite, createChannel, createCommunity, createInvite, setChannelOverride } from "@/server/communities";
import { createRole, listRoles, setMemberRole, updateRole } from "@/server/moderation";
import { chooseOnboarding, getOnboarding, reopenOnboarding, setOnboardingOptions } from "@/server/onboarding";
import { Permission } from "@/server/permissions";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string, mod: string;
let communityId: string, gamers: string, artists: string, moderators: string, gamesChannel: string;

beforeAll(async () => {
  [owner, member, mod] = await Promise.all(["Owner", "Member", "Mod"].map(users.create));
  ({ communityId } = await createCommunity(owner, "Onboarding"));
  for (const u of [member, mod]) await acceptInvite(u, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
  gamers = await createRole(owner, communityId, "gamers", []);
  artists = await createRole(owner, communityId, "artists", []);
  moderators = await createRole(owner, communityId, "moderators", ["ManageRoles", "KickMembers", "ViewChannels", "SendMessages"]);
  await setMemberRole(owner, moderators, mod, true);
  const everyone = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
  gamesChannel = await createChannel(owner, communityId, "games");
  await setChannelOverride(owner, gamesChannel, everyone, 0, Permission.ViewChannels);
  await setChannelOverride(owner, gamesChannel, gamers, Permission.ViewChannels, 0);
});
afterAll(() => users.cleanup());

describe("community onboarding", () => {
  it("offers only harmless roles ranked below every moderating role", async () => {
    await expect(setOnboardingOptions(owner, communityId, [{ roleId: moderators, label: "Mods" }])).rejects.toThrow("moderation permissions");
    // Created after the moderators role, so it ranks above them.
    const high = await createRole(owner, communityId, "high", []);
    await expect(setOnboardingOptions(owner, communityId, [{ roleId: high, label: "High" }])).rejects.toThrow("rank below");
    await expect(setOnboardingOptions(member, communityId, [{ roleId: gamers, label: "Games" }])).rejects.toThrow();
    await setOnboardingOptions(owner, communityId, [{ roleId: gamers, label: "Games" }, { roleId: artists, label: "Art" }]);
  });

  it("asks once, grants picked roles (unlocking channels) and removes unpicked offered ones", async () => {
    const before = await getOnboarding(member, communityId);
    expect(before.pending).toBe(true);
    expect(before.options.map((o) => o.label)).toEqual(["Games", "Art"]);
    expect(await loadChannelAuthority(db, gamesChannel, member)).toBeNull();

    const games = before.options.find((o) => o.label === "Games")!.id;
    await chooseOnboarding(member, communityId, [games]);
    const after = await getOnboarding(member, communityId);
    expect(after.pending).toBe(false);
    expect(after.options.find((o) => o.id === games)?.selected).toBe(true);
    expect(await loadChannelAuthority(db, gamesChannel, member)).not.toBeNull();

    await reopenOnboarding(member, communityId);
    expect((await getOnboarding(member, communityId)).pending).toBe(true);
    await chooseOnboarding(member, communityId, []);
    expect(await loadChannelAuthority(db, gamesChannel, member)).toBeNull();
    expect((await getOnboarding(member, communityId)).pending).toBe(false);
  });

  it("refuses an option whose role gained moderation permissions after it was offered", async () => {
    const art = (await getOnboarding(member, communityId)).options.find((o) => o.label === "Art")!.id;
    await updateRole(owner, artists, "artists", ["KickMembers"]);
    await expect(chooseOnboarding(member, communityId, [art])).rejects.toThrow("no longer available");
    await expect(chooseOnboarding(member, communityId, ["00000000-0000-4000-8000-000000000000"])).rejects.toThrow("no longer exists");
  });
});
