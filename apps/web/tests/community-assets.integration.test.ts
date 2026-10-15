import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attachment, community, communityAsset, user } from "@/db/schema";
import { assetToken } from "@/lib/community-assets";
import { createCommunityAsset, deleteCommunityAsset, listCommunityAssets, readCommunityAsset } from "@/server/community-assets";
import { acceptInvite, createCommunity, createInvite, leaveCommunity } from "@/server/communities";
import { mediaEnabled, processImage, sweepAttachments } from "@/server/media";
import { editMessage, listMessages, sendMessage, toggleReaction } from "@/server/messages";
import { createRole, setMemberRole } from "@/server/moderation";
import { testUsers } from "./helpers";

describe.skipIf(!mediaEnabled)("private community emoji and stickers", () => {
  const users = testUsers();
  let manager: string; let member: string; let outsider: string;
  let communityId: string; let channelId: string; let otherChannelId: string;
  beforeAll(async () => {
    manager = await users.create("Asset manager"); member = await users.create("Asset member"); outsider = await users.create("Asset outsider");
    ({ communityId, channelId } = await createCommunity(manager, "Private images"));
    ({ channelId: otherChannelId } = await createCommunity(outsider, "Other images"));
    await acceptInvite(member, await createInvite(manager, communityId, { maxUses: null, expiresInHours: null }));
  });
  afterAll(async () => { await db.delete(communityAsset).where(eq(communityAsset.communityId, communityId)); await sweepAttachments(); await users.cleanup(); });
  async function upload(name: string, kind: "emoji" | "sticker" = "emoji", userId = manager) {
    const bytes = await sharp({ create: { width: 180, height: 160, channels: 4, background: "#333333" } }).png().toBuffer();
    return createCommunityAsset(userId, communityId, { name, kind }, bytes.length, async () => bytes, new AbortController().signal);
  }
  it("checks manager access before reading, and serializes same-name uploads", async () => {
    await expect(upload("member_no", "emoji", member)).rejects.toThrow();
    const result = await Promise.allSettled([upload("same_name"), upload("same_name")]);
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const asset = (await listCommunityAssets(member, communityId)).find((asset) => asset.name === "same_name")!;
    expect(asset.width).toBeLessThanOrEqual(128);
    const [row] = await db.select().from(attachment).where(eq(attachment.assetId, asset.id));
    expect(row.linkedAt).not.toBeNull(); expect(row.messageId).toBeNull();
    expect((await readCommunityAsset(member, asset.id)).status).toBe(200);
    await expect(readCommunityAsset(outsider, asset.id)).rejects.toThrow();
  });
  it("binds send/edit/reactions to the channel community and preserves removal after deletion", async () => {
    const asset = await upload("reaction_blob"); const token = assetToken(asset);
    await expect(sendMessage(outsider, otherChannelId, token)).rejects.toThrow(/another community/);
    const posted = await sendMessage(member, channelId, token);
    expect(posted.assets).toContainEqual(asset);
    await toggleReaction(member, posted.id, token);
    expect((await listMessages(member, channelId)).messages.find((message) => message.id === posted.id)?.reactions[0].asset).toEqual(asset);
    await deleteCommunityAsset(manager, communityId, asset.id);
    await expect(readCommunityAsset(member, asset.id)).rejects.toThrow();
    await expect(editMessage(member, posted.id, token)).rejects.toThrow(/removed/);
    await toggleReaction(member, posted.id, token);
    const historical = (await listMessages(member, channelId)).messages.find((message) => message.id === posted.id)!;
    expect(historical.assets).toEqual([]); expect(historical.reactions).toEqual([]);
    await sweepAttachments();
    expect(await db.select().from(attachment).where(and(eq(attachment.assetId, asset.id)))).toEqual([]);
  });
  it("serializes concurrent capacity checks at the emoji cap", async () => {
    const previous = await db.select().from(communityAsset).where(eq(communityAsset.communityId, communityId));
    const filler = await db.insert(communityAsset).values(Array.from({ length: 127 - previous.length }, (_, index) => ({ communityId, name: `cap_${index}`, kind: "emoji" as const }))).returning();
    try {
      const result = await Promise.allSettled([upload("cap_last_a"), upload("cap_last_b")]);
      expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      expect(await db.select().from(communityAsset).where(eq(communityAsset.communityId, communityId))).toHaveLength(128);
    } finally {
      for (const asset of filler) await db.delete(communityAsset).where(eq(communityAsset.id, asset.id));
    }
  });
  it("retains community ownership after uploader deletion, then cleans up a deleted community", async () => {
    const uploader = await users.create("Library contributor");
    await acceptInvite(uploader, await createInvite(manager, communityId, { maxUses: null, expiresInHours: null }));
    const role = await createRole(manager, communityId, "Image manager", ["ManageCommunity"]);
    await setMemberRole(manager, role, uploader, true);
    const asset = await upload("owned_library", "emoji", uploader);
    await db.delete(user).where(eq(user.id, uploader));
    const [row] = await db.select().from(attachment).where(eq(attachment.assetId, asset.id));
    expect(row.uploaderId).toBeNull();
    expect((await readCommunityAsset(manager, asset.id)).status).toBe(200);
    const destination = await createCommunity(manager, "Disposable library");
    const moved = await db.insert(communityAsset).values({ communityId: destination.communityId, name: "owned_image", kind: "emoji" }).returning();
    await db.transaction(async (tx) => {
      await tx.delete(communityAsset).where(eq(communityAsset.id, asset.id));
      await tx.update(attachment).set({ assetId: moved[0].id }).where(eq(attachment.id, row.id));
    });
    await db.delete(community).where(eq(community.id, destination.communityId));
    await expect(readCommunityAsset(manager, moved[0].id)).rejects.toThrow();
    await sweepAttachments();
    expect(await db.select().from(attachment).where(eq(attachment.id, row.id))).toEqual([]);
  });
  it("denies future private delivery after membership loss", async () => {
    const asset = await upload("revoked_image");
    await leaveCommunity(member, communityId);
    await expect(readCommunityAsset(member, asset.id)).rejects.toThrow();
    await expect(listCommunityAssets(member, communityId)).rejects.toThrow();
  });
  it("rejects animated and oversized decoded images in static processing", async () => {
    const animated = await sharp({ create: { width: 8, height: 16, channels: 3, background: "#333", noise: { type: "gaussian", mean: 100, sigma: 20 }, pageHeight: 8 } }).webp().toBuffer();
    await expect(processImage(animated, { maximumFrames: 1, maximumPixels: 1_048_576 })).rejects.toThrow(/static/);
    const large = await sharp({ create: { width: 1025, height: 1024, channels: 3, background: "#333" } }).png().toBuffer();
    await expect(processImage(large, { maximumFrames: 1, maximumPixels: 1_048_576 })).rejects.toThrow(/large/);
  });
});
