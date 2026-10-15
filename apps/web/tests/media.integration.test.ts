// Image processing runs everywhere; the storage round trip needs R2_* credentials (skipped otherwise).
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attachment } from "@/db/schema";
import { MAX_ATTACHMENT_BYTES } from "@/lib/limits";
import { exportUserData } from "@/server/account";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { mediaEnabled, processImage, readAttachment, readLimited, sweepAttachments, uploadAttachment } from "@/server/media";
import { deleteMessage, listMessages, sendMessage } from "@/server/messages";
import { testUsers } from "./helpers";

const jpegWithGps = () =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: "#6366f1" } })
    .jpeg()
    .withExif({ IFD0: { Make: "QA Camera" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "52/1 31/1 0/1" } })
    .toBuffer();

describe("image processing", () => {
  it("re-encodes to WebP and drops EXIF/GPS metadata", async () => {
    const input = await jpegWithGps();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await processImage(input);
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect([out.width, out.height]).toEqual([64, 48]);
  });

  it("refuses non-images, SVG and oversized files by content, not by name", async () => {
    await expect(processImage(new TextEncoder().encode("<html>not an image</html>"))).rejects.toThrow(/supported image/);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    await expect(processImage(svg)).rejects.toThrow(/PNG, JPEG, WebP or GIF|supported image/);
    await expect(processImage(new Uint8Array(0))).rejects.toThrow(/empty/);
    await expect(processImage(new Uint8Array(MAX_ATTACHMENT_BYTES + 1))).rejects.toThrow(/at most/);
  });

  it("caps the decoded size of animations across all frames", async () => {
    // 100 distinct 750×750 frames (noise, so the encoder can't merge them): 56 Mpx decoded, under 1 MB on disk.
    const anim = await sharp({ create: { width: 750, height: 75_000, channels: 3, background: "#000", noise: { type: "gaussian", mean: 128, sigma: 30 }, pageHeight: 750 } })
      .webp({ quality: 1, effort: 0 }).toBuffer();
    expect((await sharp(anim, { animated: true }).metadata()).pages).toBe(100);
    await expect(processImage(anim)).rejects.toThrow(/too large/);
  }, 30_000); // generating 100 noise frames is slow on CI runners

  it("stops reading a body that is longer than announced", async () => {
    await expect(readLimited(new Blob([new Uint8Array(2048)]).stream(), 1024)).rejects.toThrow(/at most/);
    expect((await readLimited(new Blob([new Uint8Array(1024)]).stream(), 1024)).byteLength).toBe(1024);
  });

  it("shrinks very large images", async () => {
    const big = await sharp({ create: { width: 6000, height: 1000, channels: 3, background: "#000" } }).png().toBuffer();
    const out = await processImage(big);
    expect(out.width).toBe(4096);
  });
});

describe.skipIf(!mediaEnabled)("attachments in R2", () => {
  const fixtures = testUsers();
  let author: string;
  let member: string;
  let outsider: string;
  let channelId: string;
  const ids: string[] = [];

  beforeAll(async () => {
    author = await fixtures.create("Uploader");
    member = await fixtures.create("Viewer");
    outsider = await fixtures.create("Outsider");
    const c = await createCommunity(author, "Media test");
    channelId = c.channelId;
    await acceptInvite(member, await createInvite(author, c.communityId, { maxUses: null, expiresInHours: null }));
  });
  afterAll(async () => {
    // Unlink and age the rows so the sweeper deletes the stored objects too.
    if (ids.length) await db.update(attachment).set({ messageId: null, createdAt: new Date(0) }).where(inArray(attachment.id, ids));
    await sweepAttachments();
    await fixtures.cleanup();
  });

  const upload = async (userId: string, type = "image/jpeg") => {
    const bytes = await jpegWithGps();
    return uploadAttachment(userId, channelId, type, bytes.byteLength, (limit) => readLimited(new Blob([new Uint8Array(bytes)]).stream(), limit));
  };

  it("validates type, size and permission before reading the body", async () => {
    let read = false;
    const body = async () => { read = true; return new Uint8Array(1); };
    await expect(uploadAttachment(author, channelId, "image/svg+xml", 10, body)).rejects.toThrow(/PNG, JPEG/);
    await expect(uploadAttachment(author, channelId, "image/png", MAX_ATTACHMENT_BYTES + 1, body)).rejects.toThrow(/at most/);
    await expect(uploadAttachment(outsider, channelId, "image/png", 10, body)).rejects.toThrow(/not found/);
    expect(read).toBe(false);
  });

  it("links uploads to a message and serves them only to channel members", async () => {
    const view = await upload(author);
    ids.push(view.id);
    // Unsent uploads are never served, not even to their uploader.
    await expect(readAttachment(author, view.id)).rejects.toThrow(/not found/);
    // Someone else can't attach another person's upload.
    await expect(sendMessage(member, channelId, "", [view.id])).rejects.toThrow(/no longer available/);

    const message = await sendMessage(author, channelId, "", [view.id]);
    expect(message.attachments).toEqual([view]);
    expect((await listMessages(member, channelId)).messages.at(-1)?.attachments).toEqual([view]);

    const exported = await exportUserData(author);
    expect(exported.messages.find((m) => m.id === message.id)?.images).toEqual([expect.objectContaining({ id: view.id, url: `/api/attachments/${view.id}` })]);

    const res = await readAttachment(member, view.id);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).exif).toBeUndefined();
    await expect(readAttachment(outsider, view.id)).rejects.toThrow(/not found/);

    // Reusing a sent attachment fails; deleting the message makes it unreachable at once.
    await expect(sendMessage(author, channelId, "again", [view.id])).rejects.toThrow(/no longer available/);
    await deleteMessage(author, message.id);
    await expect(readAttachment(member, view.id)).rejects.toThrow(/not found/);
    await expect(sendMessage(author, channelId, "repost", [view.id])).rejects.toThrow(/no longer available/);
    // Removed images are deleted from storage right away, not after the unsent-upload grace period.
    await sweepAttachments();
    expect(await db.select().from(attachment).where(eq(attachment.id, view.id))).toHaveLength(0);
  });

  it("requires text or at least one image", async () => {
    await expect(sendMessage(author, channelId, "  ", [])).rejects.toThrow(/empty/);
  });
});
