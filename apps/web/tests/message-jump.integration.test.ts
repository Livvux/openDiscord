// Requires a migrated database at DATABASE_URL.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, createChannel, createCommunity, createInvite, setChannelOverride } from "@/server/communities";
import { deleteMessage, listMessages, openMessage, PAGE_SIZE, sendMessage } from "@/server/messages";
import { listRoles } from "@/server/moderation";
import { Permission } from "@/server/permissions";
import { db } from "@/db";
import { message } from "@/db/schema";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, member: string, outsider: string;
let communityId: string, generalId: string;
/** 130 top-level messages, oldest first. */
let ids: string[];

/** UUIDv7 ids with explicit, spaced times: the order doesn't depend on the database clock. */
function uuidv7(ms: number) {
  const time = ms.toString(16).padStart(12, "0");
  const rand = randomBytes(10).toString("hex");
  return `${time.slice(0, 8)}-${time.slice(8)}-7${rand.slice(0, 3)}-${(8 | (parseInt(rand[3], 16) & 3)).toString(16)}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}
async function seed(channelId: string, count: number, start: number, threadId: string | null = null) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: uuidv7(start + i * 1000), channelId, authorId: owner, content: `m${i}`, createdAt: new Date(start + i * 1000), threadId,
  }));
  await db.insert(message).values(rows);
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all(["Owner", "Member", "Outsider"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "Jumps"));
  await acceptInvite(member, await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 1 }));
  ids = await seed(generalId, 130, Date.now() - 86_400_000);
});
afterAll(() => users.cleanup());

const window = (page: { messages: { id: string }[] }) => page.messages.map((m) => m.id);

describe("pages around a message", () => {
  it("centers an old message with flags for both directions", async () => {
    const page = await listMessages(member, generalId, undefined, undefined, { around: ids[40] });
    expect(page.messages).toHaveLength(PAGE_SIZE);
    expect(window(page)).toEqual(ids.slice(15, 65));
    expect(page).toMatchObject({ hasMore: true, hasNewer: true });
    expect(page.unavailable).toBeUndefined();
  });

  it("clips at both ends of the history", async () => {
    const first = await listMessages(member, generalId, undefined, undefined, { around: ids[2] });
    expect(window(first)).toEqual(ids.slice(0, 27));
    expect(first).toMatchObject({ hasMore: false, hasNewer: true });
    const last = await listMessages(member, generalId, undefined, undefined, { around: ids[128] });
    expect(window(last)).toEqual(ids.slice(103, 130));
    expect(last).toMatchObject({ hasMore: true, hasNewer: false });
  });

  it("pages forward with after until the present", async () => {
    const one = await listMessages(member, generalId, undefined, undefined, { after: ids[40] });
    expect(window(one)).toEqual(ids.slice(41, 91));
    expect(one.hasNewer).toBe(true);
    const two = await listMessages(member, generalId, undefined, undefined, { after: ids[90] });
    expect(window(two)).toEqual(ids.slice(91));
    expect(two.hasNewer).toBe(false);
  });

  it("rejects malformed and combined cursors", async () => {
    await expect(listMessages(member, generalId, undefined, undefined, { around: "nope" })).rejects.toThrow("Invalid id.");
    await expect(listMessages(member, generalId, undefined, undefined, { after: "nope" })).rejects.toThrow("Invalid id.");
    await expect(listMessages(member, generalId, ids[3], undefined, { after: ids[1] })).rejects.toThrow("only one of");
  });

  it("checks channel access on every load", async () => {
    await expect(listMessages(outsider, generalId, undefined, undefined, { around: ids[40] })).rejects.toThrow();
    await expect(listMessages(outsider, generalId, undefined, undefined, { after: ids[40] })).rejects.toThrow();
    await expect(openMessage(outsider, generalId, ids[40])).rejects.toThrow();
  });
});

describe("direct message links", () => {
  it("opens a channel message", async () => {
    const { page, target } = await openMessage(member, generalId, ids[40]);
    expect(target).toEqual({ id: ids[40], threadId: null, threadPage: null });
    expect(window(page)).toEqual(ids.slice(15, 65));
    expect(page.unavailable).toBeUndefined();
  });

  it("opens a thread reply around its root, with the thread page around the reply", async () => {
    const root = await sendMessage(owner, generalId, "thread root");
    const replies = await seed(generalId, 80, Date.now() + 1000, root.id);
    const { page, target } = await openMessage(member, generalId, replies[10]);
    expect(target).toMatchObject({ id: replies[10], threadId: root.id });
    expect(window(page)).toContain(root.id);
    expect(window(page)).not.toContain(replies[10]);
    expect(window(target!.threadPage!)).toEqual(replies.slice(0, 35));
    expect(target!.threadPage).toMatchObject({ hasMore: false, hasNewer: true });
    // A reply isn't a top-level message: around it in the main list is unavailable.
    expect((await listMessages(member, generalId, undefined, undefined, { around: replies[10] })).unavailable).toBe(true);
  });

  it("treats a deleted message as unavailable and returns only the newest page", async () => {
    const gone = await sendMessage(member, generalId, "secret soon gone");
    await deleteMessage(member, gone.id);
    const { page, target } = await openMessage(member, generalId, gone.id);
    expect(target).toBeNull();
    expect(page.unavailable).toBe(true);
    expect(page.hasNewer).toBeUndefined();
    expect(page.messages.map((m) => m.content)).not.toContain("secret soon gone");
    expect(window(page)).toEqual(window(await listMessages(member, generalId)));
  });

  it("treats ids of other or unreadable channels like deleted ones", async () => {
    const hidden = await createChannel(owner, communityId, "mods");
    const everyone = (await listRoles(owner, communityId)).find((r) => r.isDefault)!;
    await setChannelOverride(owner, hidden, everyone.id, 0, Permission.ViewChannels);
    const elsewhere = await sendMessage(owner, hidden, "mods only plan");
    const viaGeneral = await openMessage(member, generalId, elsewhere.id);
    const viaGeneralForOwner = await openMessage(owner, generalId, elsewhere.id);
    for (const { page, target } of [viaGeneral, viaGeneralForOwner]) {
      expect(target).toBeNull();
      expect(page.unavailable).toBe(true);
      expect(page.messages.every((m) => m.channelId === generalId)).toBe(true);
    }
    expect(viaGeneral).toEqual(viaGeneralForOwner);
    // The hidden channel itself still fails exactly like before.
    await expect(openMessage(member, hidden, elsewhere.id)).rejects.toThrow();
    await expect(listMessages(member, hidden, undefined, undefined, { around: elsewhere.id })).rejects.toThrow();
  });

  it("treats malformed ids like unavailable ones", async () => {
    for (const bad of ["nope", ["a", "b"], ""]) {
      const { page, target } = await openMessage(member, generalId, bad);
      expect(target).toBeNull();
      expect(page.unavailable).toBe(true);
    }
  });
});
