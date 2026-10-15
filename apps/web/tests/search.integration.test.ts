// Requires a migrated database at DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { message } from "@/db/schema";
import { blockUser } from "@/server/blocks";
import { acceptInvite, createChannel, createCommunity, createInvite, setChannelOverride } from "@/server/communities";
import { searchMessages, SEARCH_LIMIT, toPrefixQuery } from "@/server/messages";
import { listRoles } from "@/server/moderation";
import { Permission } from "@/server/permissions";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string, outsider: string, pest: string;
let communityId: string, generalId: string, hiddenId: string;

const seed = (channelId: string, authorId: string, content: string) => db.insert(message).values({ channelId, authorId, content });

beforeAll(async () => {
  [owner, member, outsider, pest] = await Promise.all(["Owner", "Member", "Outsider", "Pest"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "Searchable"));
  for (const u of [member, pest]) await acceptInvite(u, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
  hiddenId = await createChannel(owner, communityId, "secret");
  const everyone = (await listRoles(owner, communityId)).find((r) => r.isDefault)!.id;
  await setChannelOverride(owner, hiddenId, everyone, 0, Permission.ViewChannels);
  await seed(generalId, owner, "Der Grillabend ist am Freitag");
  await seed(generalId, pest, "grillabend spam");
  await seed(hiddenId, owner, "Grillabend budget is secret");
});
afterAll(() => users.cleanup());

describe("search", () => {
  it("builds prefix queries from letters and digits only", () => {
    expect(toPrefixQuery("Grill  Fre")).toBe("grill:* & fre:*");
    expect(toPrefixQuery("a' | b & !c:*")).toBe("a:* & b:* & c:*");
    expect(toPrefixQuery("  !!! ")).toBeNull();
  });

  it("finds words by prefix, case-insensitively, newest first", async () => {
    const results = await searchMessages(member, communityId, "GRILL");
    expect(results.map((r) => r.content)).toEqual(["grillabend spam", "Der Grillabend ist am Freitag"]);
    expect(results[0].channelName).toBe("general");
    expect((await searchMessages(member, communityId, "grill frei")).map((r) => r.content)).toEqual(["Der Grillabend ist am Freitag"]);
  });

  it("never returns messages from channels the person can't read", async () => {
    expect((await searchMessages(member, communityId, "budget"))).toEqual([]);
    expect((await searchMessages(owner, communityId, "budget")).map((r) => r.content)).toEqual(["Grillabend budget is secret"]);
  });

  it("refuses non-members and skips blocked authors", async () => {
    await expect(searchMessages(outsider, communityId, "grill")).rejects.toThrow("Community not found.");
    await blockUser(member, pest);
    expect((await searchMessages(member, communityId, "grill")).map((r) => r.content)).toEqual(["Der Grillabend ist am Freitag"]);
  });

  it("pages with a cursor", async () => {
    await db.insert(message).values(Array.from({ length: SEARCH_LIMIT + 5 }, (_, i) => ({ channelId: generalId, authorId: owner, content: `paging item ${i}` })));
    const first = await searchMessages(owner, communityId, "paging");
    expect(first).toHaveLength(SEARCH_LIMIT);
    const next = await searchMessages(owner, communityId, "paging", first.at(-1)!.id);
    expect(next).toHaveLength(5);
  });
});
