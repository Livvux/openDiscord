import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attachment, user } from "@/db/schema";
import { AVATAR_DIMENSION } from "@/lib/limits";
import { exportUserData } from "@/server/account";
import { ownAvatar, readAvatar, removeAvatar, setAvatar } from "@/server/avatars";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { mediaEnabled, sweepAttachments } from "@/server/media";
import { listMessages, sendMessage } from "@/server/messages";
import { listMembers } from "@/server/moderation";
import { testUsers } from "./helpers";

describe.skipIf(!mediaEnabled)("profile pictures", () => {
  const users = testUsers();
  let owner: string; let peer: string; let outsider: string; let communityId: string; let channelId: string;
  beforeAll(async () => {
    owner = await users.create("Avatar owner"); peer = await users.create("Avatar peer"); outsider = await users.create("Avatar outsider");
    ({ communityId, channelId } = await createCommunity(owner, "Avatars"));
    await acceptInvite(peer, await createInvite(owner, communityId, { maxUses: null, expiresInHours: null }));
  });
  afterAll(async () => { await users.cleanup(); await sweepAttachments(); });

  const upload = async (userId: string, width = 600, height = 300) => {
    const bytes = await sharp({ create: { width, height, channels: 3, background: "#22c55e" } }).png().toBuffer();
    return setAvatar(userId, bytes.length, async () => bytes, new AbortController().signal);
  };

  it("stores a square picture, shows it to people who share a community and hides it from others", async () => {
    const id = await upload(owner);
    expect(await ownAvatar(owner)).toBe(id);
    const response = await readAvatar(peer, id);
    const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", AVATAR_DIMENSION, AVATAR_DIMENSION]);
    await expect(readAvatar(outsider, id)).rejects.toThrow(/not found/i);
    expect((await listMembers(peer, communityId)).find((m) => m.userId === owner)?.avatar).toBe(id);
    await sendMessage(owner, channelId, "hello");
    expect((await listMessages(peer, channelId)).messages.at(-1)?.authorAvatar).toBe(id);
    expect((await exportUserData(owner)).profile.avatarUrl).toBe(`/api/avatars/${id}`);
  });

  it("replaces and removes pictures, and the sweeper deletes the old objects", async () => {
    const first = await upload(peer, 64, 64);
    const second = await upload(peer, 64, 64);
    expect(await ownAvatar(peer)).toBe(second);
    await expect(readAvatar(owner, first)).rejects.toThrow(/not found/i);
    await sweepAttachments();
    expect(await db.select().from(attachment).where(eq(attachment.id, first))).toEqual([]);
    await removeAvatar(peer);
    expect(await ownAvatar(peer)).toBeNull();
    await sweepAttachments();
    expect(await db.select().from(attachment).where(eq(attachment.id, second))).toEqual([]);
  });

  it("deletes the picture with the account", async () => {
    const id = await upload(outsider, 64, 64);
    await db.delete(user).where(eq(user.id, outsider));
    await sweepAttachments();
    expect(await db.select().from(attachment).where(eq(attachment.id, id))).toEqual([]);
  });

  it("refuses oversized and non-image uploads", async () => {
    await expect(setAvatar(owner, 3 * 1024 * 1024, async () => new Uint8Array(1), new AbortController().signal)).rejects.toThrow(/at most/);
    const text = new TextEncoder().encode("<svg/>");
    await expect(setAvatar(owner, text.length, async () => text, new AbortController().signal)).rejects.toThrow(/supported image/);
  });
});
