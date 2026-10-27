// Requires a migrated database at DATABASE_URL (Postgres 18, see compose.dev.yaml / CI).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCommunity, createInvite, acceptInvite, joinDiscoverable } from "@/server/communities";
import { getDiscoverable, listDiscoverable, updateListing } from "@/server/discovery";
import { banMember } from "@/server/moderation";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, alice: string, mallory: string;
let communityId: string;
const name = `Discover ${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  [owner, alice, mallory] = await Promise.all(["Owner", "Alice", "Mallory"].map(users.create));
  ({ communityId } = await createCommunity(owner, name));
});
afterAll(() => users.cleanup());

describe("discovery", () => {
  it("keeps communities private until the owner lists them", async () => {
    expect((await listDiscoverable(name)).some((c) => c.id === communityId)).toBe(false);
    expect(await getDiscoverable(communityId)).toBeNull();
    await expect(joinDiscoverable(alice, communityId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("lets only the owner list a community", async () => {
    await acceptInvite(alice, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: null }));
    await expect(updateListing(alice, communityId, { discoverable: true, description: "" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateListing(owner, communityId, { discoverable: true, description: "x".repeat(301) })).rejects.toThrow(/300/);
    await updateListing(owner, communityId, { discoverable: true, description: "Woodworking and more" });
    const listed = await listDiscoverable("woodworking");
    expect(listed.find((c) => c.id === communityId)).toMatchObject({ name, description: "Woodworking and more", memberCount: 2 });
    expect(await listDiscoverable("%")).not.toContainEqual(expect.objectContaining({ id: communityId }));
  });

  it("joins without an invite but keeps bans", async () => {
    await joinDiscoverable(mallory, communityId);
    await banMember(owner, communityId, mallory, "spam");
    await expect(joinDiscoverable(mallory, communityId)).rejects.toThrow(/banned/);
    const [eve] = await Promise.all(["Eve"].map(users.create));
    expect(await joinDiscoverable(eve, communityId)).toBe(communityId);
    expect((await getDiscoverable(communityId))?.memberCount).toBe(3);
  });

  it("stops joins once unlisted", async () => {
    await updateListing(owner, communityId, { discoverable: false, description: "" });
    const [frank] = await Promise.all(["Frank"].map(users.create));
    await expect(joinDiscoverable(frank, communityId)).rejects.toMatchObject({ code: "not_found" });
  });
});
