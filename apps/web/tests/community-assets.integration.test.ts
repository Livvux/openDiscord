import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attachment, communityAsset } from "@/db/schema";
import { assetToken } from "@/lib/community-assets";
import { createCommunityAsset, deleteCommunityAsset, listCommunityAssets, readCommunityAsset } from "@/server/community-assets";
import { acceptInvite, createCommunity, createInvite, leaveCommunity } from "@/server/communities";
import { mediaEnabled, processImage, sweepAttachments } from "@/server/media";
import { editMessage, listMessages, sendMessage, toggleReaction } from "@/server/messages";
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
    await expect(sweepAttachments()).resolves.toBeGreaterThanOrEqual(1);
    expect(await db.select().from(attachment).where(and(eq(attachment.assetId, asset.id)))).toEqual([]);
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
