// Requires a migrated database at DATABASE_URL (Postgres 18, see compose.dev.yaml / CI).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { invite, message } from "@/db/schema";
import { exportUserData } from "@/server/account";
import {
  acceptInvite,
  createChannel,
  createCommunity,
  createInvite,
  deleteChannel,
  getCommunityView,
  getInvitePreview,
  leaveCommunity,
  listCommunities,
} from "@/server/communities";
import { deleteMessage, editMessage, listMessages, PAGE_SIZE, RATE_LIMIT, sendMessage } from "@/server/messages";
import {
  banMember,
  createRole,
  kickMember,
  listAuditLog,
  listMembers,
  setMemberRole,
  unbanMember,
  updateRole,
} from "@/server/moderation";
import { testUsers } from "./helpers";

const users = testUsers();
let owner: string, alice: string, bob: string, mallory: string;
let communityId: string, generalId: string;

async function join(userId: string) {
  const code = await createInvite(owner, communityId, { expiresInHours: 24, maxUses: null });
  await acceptInvite(userId, code);
}

beforeAll(async () => {
  [owner, alice, bob, mallory] = await Promise.all(["Owner", "Alice", "Bob", "Mallory"].map(users.create));
  ({ communityId, channelId: generalId } = await createCommunity(owner, "  Test Community  "));
});
afterAll(() => users.cleanup());

describe("communities", () => {
  it("creates a community with a #general channel and the creator as owner", async () => {
    const view = await getCommunityView(owner, communityId);
    expect(view.name).toBe("Test Community");
    expect(view.isOwner).toBe(true);
    expect(view.channels.map((c) => c.name)).toEqual(["general"]);
    expect(await listCommunities(owner)).toContainEqual({ id: communityId, name: "Test Community" });
  });

  it("rejects invalid names", async () => {
    await expect(createCommunity(owner, "   ")).rejects.toThrow("Give your community a name.");
    await expect(createChannel(owner, communityId, "no/slashes")).rejects.toThrow(/letters, numbers/);
  });

  it("hides communities from non-members as not found (no IDOR)", async () => {
    await expect(getCommunityView(mallory, communityId)).rejects.toMatchObject({ code: "not_found" });
    await expect(listMessages(mallory, generalId)).rejects.toMatchObject({ code: "not_found" });
    await expect(sendMessage(mallory, generalId, "hi")).rejects.toMatchObject({ code: "not_found" });
    await expect(listMembers(mallory, communityId)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("invites", () => {
  it("lets people join with a valid invite and counts uses once", async () => {
    const code = await createInvite(owner, communityId, { expiresInHours: 24, maxUses: 5 });
    expect((await getInvitePreview(code)).communityName).toBe("Test Community");
    expect(await acceptInvite(alice, code)).toBe(communityId);
    await acceptInvite(alice, code);
    const [row] = await db.select().from(invite).where(eq(invite.code, code));
    expect(row.uses).toBe(1);
  });

  it("rejects exhausted and expired invites", async () => {
    const single = await createInvite(owner, communityId, { expiresInHours: null, maxUses: 1 });
    await acceptInvite(bob, single);
    await expect(acceptInvite(mallory, single)).rejects.toMatchObject({ code: "not_found" });

    const expired = await createInvite(owner, communityId, { expiresInHours: 1, maxUses: null });
    await db.update(invite).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invite.code, expired));
    await expect(getInvitePreview(expired)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects malformed invite options", async () => {
    await expect(createInvite(owner, communityId, { expiresInHours: 99999, maxUses: null })).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("messages", () => {
  it("sends, paginates, edits and deletes", async () => {
    const sent = await sendMessage(alice, generalId, "  hello world  ");
    expect(sent.content).toBe("hello world");
    expect(sent.authorName).toBe("Alice");

    await editMessage(alice, sent.id, "hello again");
    const page = await listMessages(bob, generalId);
    const edited = page.messages.find((m) => m.id === sent.id);
    expect(edited?.content).toBe("hello again");
    expect(edited?.editedAt).not.toBeNull();

    await expect(editMessage(bob, sent.id, "hijack")).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteMessage(bob, sent.id)).rejects.toMatchObject({ code: "forbidden" });
    await deleteMessage(alice, sent.id);
    expect((await listMessages(bob, generalId)).messages.some((m) => m.id === sent.id)).toBe(false);
  });

  it("rate-limits bursts", async () => {
    const ch = await createChannel(owner, communityId, "burst");
    const results = [];
    for (let i = 0; i <= RATE_LIMIT.messages; i++) {
      results.push(await sendMessage(bob, ch, `msg ${i}`).then(() => "ok", (e: { code: string }) => e.code));
    }
    expect(results.at(-1)).toBe("rate_limited");
    expect(results.slice(0, RATE_LIMIT.messages).every((r) => r === "ok")).toBe(true);
  });

  it("paginates with a cursor, oldest first within a page", async () => {
    const ch = await createChannel(owner, communityId, "history");
    // Insert directly to avoid the rate limit; ids are UUIDv7 so order follows insertion.
    await db.insert(message).values(
      Array.from({ length: PAGE_SIZE + 5 }, (_, i) => ({ channelId: ch, authorId: owner, content: `m${i}` })),
    );
    const first = await listMessages(owner, ch);
    expect(first.hasMore).toBe(true);
    expect(first.messages).toHaveLength(PAGE_SIZE);
    expect(first.messages.at(-1)?.content).toBe(`m${PAGE_SIZE + 4}`);
    const second = await listMessages(owner, ch, first.messages[0].id);
    expect(second.hasMore).toBe(false);
    expect(second.messages.map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });
});

describe("moderation and roles", () => {
  it("only lets members with permission manage channels", async () => {
    await expect(createChannel(alice, communityId, "nope")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("prevents privilege escalation through roles", async () => {
    const modRole = await createRole(owner, communityId, "Moderator", ["KickMembers", "ManageRoles", "ManageMessages"]);
    await setMemberRole(owner, modRole, alice, true);

    // Alice can't create a role with permissions she lacks, nor edit her own role.
    await expect(createRole(alice, communityId, "Evil", ["BanMembers"])).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateRole(alice, modRole, "Moderator", ["Administrator"])).rejects.toMatchObject({ code: "forbidden" });

    // She can create a lesser role and assign it.
    const helper = await createRole(alice, communityId, "Helper", ["ManageMessages"]);
    await setMemberRole(alice, helper, bob, true);
    expect((await listMembers(owner, communityId)).find((m) => m.userId === bob)?.roleIds).toContain(helper);

    // Bob (Helper) can delete others' messages but not kick.
    const msg = await sendMessage(alice, generalId, "moderate me");
    await deleteMessage(bob, msg.id);
    await expect(kickMember(bob, communityId, alice)).rejects.toMatchObject({ code: "forbidden" });

    // Alice can't touch the owner.
    await expect(kickMember(alice, communityId, owner)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("kicks, bans and blocks re-joining while banned", async () => {
    await join(mallory);
    await banMember(owner, communityId, mallory, "spam");
    await expect(getCommunityView(mallory, communityId)).rejects.toMatchObject({ code: "not_found" });
    const code = await createInvite(owner, communityId, { expiresInHours: 24, maxUses: null });
    await expect(acceptInvite(mallory, code)).rejects.toMatchObject({ code: "forbidden" });

    await unbanMember(owner, communityId, mallory);
    await acceptInvite(mallory, code);
    await kickMember(owner, communityId, mallory, "bye");
    await expect(listMessages(mallory, generalId)).rejects.toMatchObject({ code: "not_found" });

    const actions = (await listAuditLog(owner, communityId)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["member.ban", "member.unban", "member.kick", "message.delete"]));
    await expect(listAuditLog(bob, communityId)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps at least one channel and stops owners from leaving", async () => {
    const { communityId: solo, channelId } = await createCommunity(owner, "Solo");
    await expect(deleteChannel(owner, channelId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(leaveCommunity(owner, solo)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("data export", () => {
  it("includes the person's messages and memberships but no secrets", async () => {
    await sendMessage(mallory, (await createCommunity(mallory, "Mine")).channelId, "my words");
    const data = await exportUserData(mallory);
    expect(data.profile.name).toBe("Mallory");
    expect(data.messages.map((m) => m.content)).toContain("my words");
    expect(data.ownedCommunities.map((c) => c.name)).toEqual(["Mine"]);
    expect(JSON.stringify(data)).not.toMatch(/password|token/i);
  });
});
