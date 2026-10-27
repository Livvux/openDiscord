import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attachment, community, instanceAdmin, instanceAuditLog, session } from "@/db/schema";
import { BANNER_HEIGHT, BANNER_WIDTH, COMMUNITY_ICON_DIMENSION } from "@/lib/limits";
import { acceptInvite, createCommunity, createInvite, getCommunityView, getInvitePreview, listCommunityNavigation } from "@/server/communities";
import { readCommunityImage, removeCommunityImage, setCommunityImage } from "@/server/community-images";
import { listDiscoverable, updateListing } from "@/server/discovery";
import * as admin from "@/server/instance-admin";
import { mediaEnabled, sweepAttachments } from "@/server/media";
import { testUsers } from "./helpers";

const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#5865f2" } }).png().toBuffer();
const dimensions = async (response: Response) => {
  const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  return [meta.format, meta.width, meta.height];
};

describe.skipIf(!mediaEnabled)("community pictures and banners", () => {
  const users = testUsers();
  let owner: string; let peer: string; let outsider: string; let communityId: string; let inviteCode: string;
  const upload = async (userId: string, kind: string, width: number, height: number) => {
    const bytes = await png(width, height);
    return setCommunityImage(userId, communityId, kind, bytes.length, async () => bytes, new AbortController().signal);
  };
  beforeAll(async () => {
    owner = await users.create("Picture owner"); peer = await users.create("Picture peer"); outsider = await users.create("Picture outsider");
    ({ communityId } = await createCommunity(owner, "Pictures"));
    inviteCode = await createInvite(owner, communityId, { maxUses: null, expiresInHours: null });
    await acceptInvite(peer, inviteCode);
  });
  afterAll(async () => { await users.cleanup(); await sweepAttachments(); });

  it("crops the picture square and the banner to 16:9, for members only while unlisted", async () => {
    const icon = await upload(owner, "icon", 900, 400);
    const banner = await upload(owner, "banner", 400, 400);
    expect(await dimensions(await readCommunityImage(peer, icon))).toEqual(["webp", COMMUNITY_ICON_DIMENSION, COMMUNITY_ICON_DIMENSION]);
    expect(await dimensions(await readCommunityImage(peer, banner))).toEqual(["webp", BANNER_WIDTH, BANNER_HEIGHT]);
    await expect(readCommunityImage(outsider, icon)).rejects.toThrow(/not found/i);
    await expect(readCommunityImage(null, banner)).rejects.toThrow(/not found/i);
    expect((await listCommunityNavigation(peer))[0].iconId).toBe(icon);
    expect((await getCommunityView(peer, communityId)).bannerId).toBe(banner);
    expect((await getInvitePreview(inviteCode)).shareImageId).toBeNull();
  });

  it("makes pictures of listed communities public, including link previews", async () => {
    await updateListing(owner, communityId, { discoverable: true, description: "Pictures everywhere" });
    const [{ iconId, bannerId }] = await db.select().from(community).where(eq(community.id, communityId));
    expect((await readCommunityImage(null, bannerId)).status).toBe(200);
    expect((await readCommunityImage(outsider, iconId)).status).toBe(200);
    expect((await listDiscoverable("Pictures everywhere"))[0]).toMatchObject({ iconId, bannerId, verified: false });
    expect((await getInvitePreview(inviteCode)).shareImageId).toBe(bannerId);
    await updateListing(owner, communityId, { discoverable: false, description: "" });
  });

  it("needs Manage Community, and replaced or removed pictures are swept", async () => {
    await expect(upload(peer, "icon", 64, 64)).rejects.toThrow(/not found|permission/i);
    await expect(upload(owner, "avatar", 64, 64)).rejects.toThrow();
    const [{ iconId: old }] = await db.select().from(community).where(eq(community.id, communityId));
    const fresh = await upload(owner, "icon", 64, 64);
    await sweepAttachments();
    expect(await db.select().from(attachment).where(eq(attachment.id, old!))).toEqual([]);
    expect(await db.select().from(attachment).where(eq(attachment.id, fresh))).toHaveLength(1);
    await removeCommunityImage(owner, communityId, "icon");
    await sweepAttachments();
    expect(await db.select().from(attachment).where(eq(attachment.id, fresh))).toEqual([]);
  });
});

describe("community verification", () => {
  const users = testUsers();
  let root: admin.AdminActor; let owner: string; let communityId: string;
  beforeAll(async () => {
    const rootId = await users.create("Verifying operator");
    owner = await users.create("Verified owner");
    await db.insert(instanceAdmin).values({ userId: rootId });
    const sessionId = randomUUID();
    await db.insert(session).values({ id: sessionId, userId: rootId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
    root = { userId: rootId, sessionId };
    ({ communityId } = await createCommunity(owner, "Official"));
  });
  afterAll(async () => {
    await db.delete(instanceAuditLog).where(inArray(instanceAuditLog.actorId, [root.userId]));
    await db.delete(instanceAdmin).where(eq(instanceAdmin.userId, root.userId));
    await users.cleanup();
  });

  it("only instance administrators verify, with an audited reason", async () => {
    await expect(admin.setCommunityVerified({ userId: owner, sessionId: root.sessionId }, communityId, true, "Self-verify")).rejects.toThrow(/administrator access/);
    await admin.setCommunityVerified(root, communityId, true, "Official project community");
    expect((await listCommunityNavigation(owner))[0].verified).toBe(true);
    expect((await getCommunityView(owner, communityId)).verified).toBe(true);
    await admin.setCommunityVerified(root, communityId, false, "Ownership changed");
    expect((await listCommunityNavigation(owner))[0].verified).toBe(false);
    const actions = await db.select({ action: instanceAuditLog.action }).from(instanceAuditLog).where(eq(instanceAuditLog.targetId, communityId));
    expect(actions.map((a) => a.action)).toEqual(["community.verify", "community.unverify"]);
  });
});
