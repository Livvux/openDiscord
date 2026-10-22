// Image processing runs everywhere; the storage round trip needs R2_* credentials (skipped otherwise).
import { eq, inArray, sum } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attachment } from "@/db/schema";
import { MAX_ATTACHMENT_BYTES, MAX_FILE_BYTES } from "@/lib/limits";
import { exportUserData } from "@/server/account";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { cleanFilename, DAILY_UPLOAD_BYTES, mediaEnabled, mediaStorageLimit, processImage, readAttachment, readLimited, stageAvatarAttachment, sweepAttachments, uploadAttachment } from "@/server/media";
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
    await expect(readLimited(new Blob([new Uint8Array(2048)]).stream(), 1024)).rejects.toThrow(/larger than it announced/);
    expect((await readLimited(new Blob([new Uint8Array(1024)]).stream(), 1024)).byteLength).toBe(1024);
    await expect(readLimited(new Blob([new Uint8Array(512)]).stream(), 1024)).rejects.toThrow(/incomplete/);
  });

  it("gives up on a body that stalls or trickles past the deadline, and cancels it", async () => {
    let cancelled = 0;
    const stalled = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(8)); }, cancel() { cancelled += 1; } });
    await expect(readLimited(stalled(), 1024, { stallMs: 50 })).rejects.toThrow(/too slow/);
    let timer: ReturnType<typeof setInterval>;
    const trickle = new ReadableStream<Uint8Array>({ start(c) { timer = setInterval(() => c.enqueue(new Uint8Array(1)), 10); }, cancel() { clearInterval(timer); cancelled += 1; } });
    await expect(readLimited(trickle, 1024, { deadlineMs: 100, stallMs: 50 })).rejects.toThrow(/too slow/);
    expect(cancelled).toBe(2);
  });

  it("shrinks very large images", async () => {
    const big = await sharp({ create: { width: 6000, height: 1000, channels: 3, background: "#000" } }).png().toBuffer();
    const out = await processImage(big);
    expect(out.width).toBe(4096);
  });
});

describe("file names", () => {
  it("keeps only a safe display name", () => {
    expect(cleanFilename(encodeURIComponent("report (final).pdf"))).toBe("report (final).pdf");
    expect(cleanFilename(encodeURIComponent("C:\\Users\\me\\secret.txt"))).toBe("secret.txt");
    expect(cleanFilename(encodeURIComponent("a\u202egnp.exe"))).toBe("agnp.exe");
    expect(cleanFilename(encodeURIComponent(".."))).toBe("file");
    expect(cleanFilename("%E0%A4%A")).toBe("file");
    expect(cleanFilename(null)).toBe("file");
    // The end is kept, so a long name can't push the real extension out.
    expect(cleanFilename(encodeURIComponent(`${"x".repeat(300)}.exe`))).toMatch(/^x{124}\.exe$/);
    expect(cleanFilename(encodeURIComponent("invoice.pdf\u2800\u3000.exe"))).toBe("invoice.pdf .exe");
  });
});

describe.skipIf(!mediaEnabled)("attachments in private storage", () => {
  const fixtures = testUsers();
  let author: string;
  let member: string;
  let outsider: string;
  let channelId: string;
  let communityId: string;
  const ids: string[] = [];

  beforeAll(async () => {
    author = await fixtures.create("Uploader");
    member = await fixtures.create("Viewer");
    outsider = await fixtures.create("Outsider");
    const c = await createCommunity(author, "Media test");
    channelId = c.channelId;
    communityId = c.communityId;
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
    await expect(uploadAttachment(author, channelId, "image/png", MAX_ATTACHMENT_BYTES + 1, body)).rejects.toThrow(/Images can be at most/);
    await expect(uploadAttachment(author, channelId, "application/pdf", MAX_FILE_BYTES + 1, body)).rejects.toThrow(/Files can be at most/);
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

  it("stores other files unchanged and serves them only as downloads", async () => {
    const html = new TextEncoder().encode("<html><script>alert(document.cookie)</script></html>");
    const view = await uploadAttachment(author, channelId, "text/html", html.byteLength,
      (limit) => readLimited(new Blob([html]).stream(), limit), encodeURIComponent("../../evil\u202e.html"));
    ids.push(view.id);
    expect(view).toMatchObject({ filename: "evil.html", width: 0, height: 0, size: html.byteLength });
    await sendMessage(author, channelId, "notes", [view.id]);
    const res = await readAttachment(member, view.id);
    // Never rendered on this origin: generic type, forced download, sandboxed, no sniffing.
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="download"; filename*=UTF-8''evil.html`);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(html);
    await expect(readAttachment(outsider, view.id)).rejects.toThrow(/not found/);
  });

  it("releases every upload slot when slow bodies time out", async () => {
    const slow = await fixtures.create("Slow uploader");
    await acceptInvite(slow, await createInvite(author, communityId, { maxUses: null, expiresInHours: null }));
    const stalled = (limit: number) => readLimited(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(1)); } }), limit, { stallMs: 50 });
    // As many as there are slots (4): all fail clearly, then the next upload still gets one.
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => uploadAttachment(slow, channelId, "application/zip", 16, stalled, "a.zip")));
    expect(results.map((r) => r.status === "rejected" && String(r.reason))).toEqual(Array(4).fill(expect.stringMatching(/too slow/)));
    const view = await upload(slow);
    ids.push(view.id);
  });

  it("enforces the daily upload quota atomically", async () => {
    const heavy = await fixtures.create("Heavy uploader");
    await acceptInvite(heavy, await createInvite(author, communityId, { maxUses: null, expiresInHours: null }));
    // Pretend most of today's quota is already used.
    await db.insert(attachment).values({ channelId, uploaderId: heavy, key: `attachments/${heavy}.bin`, contentType: "application/octet-stream", filename: "big.bin", size: DAILY_UPLOAD_BYTES - 4, width: 0, height: 0, messageId: null, linkedAt: new Date() });
    const small = new Uint8Array(8);
    await expect(uploadAttachment(heavy, channelId, "application/zip", small.byteLength, async () => small, "a.zip")).rejects.toThrow(/per day/);
  });

  it("refuses uploads beyond the instance storage capacity, and a malformed cap", async () => {
    const [{ total }] = await db.select({ total: sum(attachment.size).mapWith(Number) }).from(attachment);
    const small = new Uint8Array(8);
    const saved = process.env.MEDIA_STORAGE_LIMIT_BYTES;
    try {
      process.env.MEDIA_STORAGE_LIMIT_BYTES = String((total ?? 0) + 4);
      await expect(uploadAttachment(author, channelId, "application/zip", small.byteLength, async () => small, "a.zip")).rejects.toThrow(/storage capacity/);
      process.env.MEDIA_STORAGE_LIMIT_BYTES = "50GiB";
      expect(() => mediaStorageLimit()).toThrow(/positive integer/);
      process.env.MEDIA_STORAGE_LIMIT_BYTES = String(Number.MAX_SAFE_INTEGER);
      ids.push((await uploadAttachment(author, channelId, "application/zip", small.byteLength, async () => small, "a.zip")).id);
    } finally {
      if (saved === undefined) delete process.env.MEDIA_STORAGE_LIMIT_BYTES; else process.env.MEDIA_STORAGE_LIMIT_BYTES = saved;
    }
  });

  it("stores nothing when the configured scanner is unreachable (fail closed)", async () => {
    const uploader = await fixtures.create("Scanned uploader");
    await acceptInvite(uploader, await createInvite(author, communityId, { maxUses: null, expiresInHours: null }));
    const saved = { host: process.env.CLAMAV_HOST, port: process.env.CLAMAV_PORT };
    // Port 1 on loopback: nothing listens there, so the connection is refused.
    Object.assign(process.env, { CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: "1" });
    try {
      const file = new TextEncoder().encode("plain file");
      await expect(uploadAttachment(uploader, channelId, "application/zip", file.byteLength, async () => file, "a.zip")).rejects.toThrow(/scanner is unavailable/);
      await expect(upload(uploader)).rejects.toThrow(/scanner is unavailable/);
      await expect(stageAvatarAttachment(uploader, await jpegWithGps(), new AbortController().signal)).rejects.toThrow(/scanner is unavailable/);
    } finally {
      for (const [key, value] of [["CLAMAV_HOST", saved.host], ["CLAMAV_PORT", saved.port]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    expect(await db.select().from(attachment).where(eq(attachment.uploaderId, uploader))).toHaveLength(0);
  });

  it("requires text or at least one image", async () => {
    await expect(sendMessage(author, channelId, "  ", [])).rejects.toThrow(/empty/);
  });
});
