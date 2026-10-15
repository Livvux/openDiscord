// Image attachments in S3-compatible object storage (Cloudflare R2 by default; docs/DECISIONS.md D9).
// Every upload is decoded and re-encoded server-side: only real raster images survive, and EXIF/GPS
// metadata is dropped. Objects are only ever served through an access-checked route.
import { randomUUID } from "node:crypto";
import { and, count, eq, gt, inArray, isNotNull, isNull, lt, or, sql, sum } from "drizzle-orm";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";
import { db } from "@/db";
import { attachment, message } from "@/db/schema";
import { ACCEPTED_IMAGE_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_FILE_BYTES, MAX_ARCHIVE_ATTACHMENTS } from "@/lib/limits";
import { requireChannel, type Db } from "./access";
import { AppError, invalid, notFound } from "./errors";
import { consume } from "./limits";
import { configuredAttachmentStorage } from "./attachment-storage";
import { scanAttachment } from "./attachment-scanner";
import { Permission } from "./permissions";
import { assertActiveUser } from "./instance-policy";
import { parse, uuid } from "./validation";

export interface AttachmentView {
  id: string;
  width: number;
  height: number;
  /** Non-image files: the original name (shown, used for the download); null for images. */
  filename: string | null;
  size: number;
}

const UPLOAD_LIMIT = { max: 10, windowMs: 60_000 };
/** Bytes one account may upload per day, so files can't fill the bucket. */
export const DAILY_UPLOAD_BYTES = 500 * 1024 * 1024;
/**
 * Uploads are buffered in memory (up to 25 MB each), so a process only works on a few at once.
 * shortcut: per process; stream to storage instead of buffering if uploads become the bottleneck.
 */
const MAX_CONCURRENT_UPLOADS = 4;
let activeUploads = 0;
/** Uploaded but not yet sent; bounds storage one account can occupy without posting. */
const MAX_UNLINKED_PER_USER = 20;
const MAX_DIMENSION = 4096;
const MAX_FRAMES = 100;
/** Decoded size across all frames, so animations can't multiply memory use. */
const MAX_TOTAL_PIXELS = 50_000_000;
const UNLINKED_TTL_MS = 60 * 60_000;
const DECODABLE = new Set(["jpeg", "png", "webp", "gif"]);

const storage = configuredAttachmentStorage();

/** Uploads are offered when private local or S3 storage is configured. */
export const mediaEnabled = storage !== null;

function requireStorage() {
  if (!storage) throw new AppError("forbidden", "Media uploads aren't enabled on this instance.");
  return storage;
}

/** Decodes, validates and re-encodes an image to WebP without metadata. */
export async function processImage(input: Uint8Array): Promise<{ data: Buffer; width: number; height: number }> {
  if (input.byteLength === 0) throw invalid("The file is empty.");
  if (input.byteLength > MAX_ATTACHMENT_BYTES) throw invalid(`Images can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  // sharp applies the pixel limit to the whole animation, a second guard for the check below.
  const options = { animated: true, limitInputPixels: MAX_TOTAL_PIXELS, failOn: "error" } as const;
  let meta: Metadata;
  try {
    // Header only: no pixel limit here, so oversized images get a clear message below.
    meta = await sharp(input, { animated: true, failOn: "error" }).metadata();
  } catch {
    throw invalid("That file isn't a supported image.");
  }
  // Format comes from the decoder, never from the client: SVG, TIFF, PDF and friends are refused.
  if (!meta.format || !DECODABLE.has(meta.format)) throw invalid("Use a PNG, JPEG, WebP or GIF image.");
  const frames = meta.pages ?? 1;
  if (frames > MAX_FRAMES) throw invalid(`Animated images can have at most ${MAX_FRAMES} frames.`);
  if ((meta.width ?? 0) * (meta.pageHeight ?? meta.height ?? 0) * frames > MAX_TOTAL_PIXELS) throw invalid("That image is too large to process.");
  try {
    const data = await sharp(input, options)
      .autoOrient()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const out = await sharp(data).metadata();
    return { data, width: out.width ?? 1, height: out.height ?? 1 };
  } catch {
    throw invalid("That image couldn't be processed.");
  }
}

const mb = (bytes: number) => `${bytes / 1024 / 1024} MB`;

/** Reads at most `limit` bytes; a body longer than it announced is cut off instead of buffered. */
export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) throw invalid("The upload is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    const chunk = r.value;
    size += chunk.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw invalid(`The upload is larger than it announced.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * A safe display/download name: no paths, control or bidi characters, at most 128 characters.
 * The name is only ever shown as text and sent in an RFC 5987 `filename*`, never used on disk.
 */
export function cleanFilename(raw: string | null): string {
  let name = "file";
  try {
    name = decodeURIComponent(raw ?? "") || "file";
  } catch {
    // Malformed encoding: fall back to the generic name.
  }
  const cleaned = name
    .normalize("NFKC")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    // Blank-looking characters (braille blank, ideographic space…) would hide a real extension.
    .replace(/[\p{Z}\u2800\u3164\uFFA0]+/gu, " ")
    .trim()
    .slice(-128);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

/** `encodeURIComponent` plus the characters RFC 5987 doesn't allow unencoded. */
const rfc5987 = (value: string) => encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const isImageType = (type: string) => (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type);

/**
 * Stores an upload for a later message. Images are decoded and re-encoded; anything else is kept as is
 * and only ever served as a download (see `readAttachment`).
 */
export async function uploadAttachment(
  userId: string,
  rawChannelId: unknown,
  contentType: string | null,
  contentLength: number,
  body: (limit: number) => Promise<Uint8Array>,
  rawFilename: string | null = null,
): Promise<AttachmentView> {
  requireStorage();
  const channelId = parse(uuid, rawChannelId);
  await consume(`upload:${userId}`, UPLOAD_LIMIT.max, UPLOAD_LIMIT.windowMs);
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const image = isImageType(type);
  const limit = image ? MAX_ATTACHMENT_BYTES : MAX_FILE_BYTES;
  // Checked before reading the body, so oversized uploads are never buffered.
  if (!Number.isFinite(contentLength) || contentLength <= 0) throw invalid("The upload needs a Content-Length.");
  if (contentLength > limit) throw invalid(`${image ? "Images" : "Files"} can be at most ${mb(limit)}.`);
  await requireChannel(db, channelId, userId, Permission.SendMessages);

  if (activeUploads >= MAX_CONCURRENT_UPLOADS) throw new AppError("rate_limited", "The server is busy with other uploads. Try again in a moment.");
  activeUploads += 1;
  try {
    return await storeUpload(userId, channelId, image, rawFilename, await body(contentLength));
  } finally {
    activeUploads -= 1;
  }
}

/** Private staging for one bounded archive; no delivery is possible until the import links it. */
export async function stageArchiveAttachment(userId: string, image: boolean, filename: string | null, raw: Uint8Array, signal: AbortSignal): Promise<AttachmentView> {
  signal.throwIfAborted();
  await assertActiveUser(userId);
  if (raw.byteLength === 0 || raw.byteLength > (image ? MAX_ATTACHMENT_BYTES : MAX_FILE_BYTES)) throw invalid("An archived file exceeds the upload limit.");
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) throw new AppError("rate_limited", "The server is busy with other uploads. Try again in a moment.");
  activeUploads += 1;
  try {
    return await storeUpload(userId, null, image, filename === null ? null : encodeURIComponent(filename), raw, MAX_ARCHIVE_ATTACHMENTS, signal);
  } finally { activeUploads -= 1; }
}

async function storeUpload(userId: string, channelId: string | null, image: boolean, rawFilename: string | null, raw: Uint8Array, maximumPending = MAX_UNLINKED_PER_USER, signal?: AbortSignal): Promise<AttachmentView> {
  const storage = requireStorage();
  await scanAttachment(raw);
  let stored: { data: Uint8Array; contentType: string; width: number; height: number; filename: string | null; ext: string };
  if (image) {
    const processed = await processImage(raw);
    stored = { data: processed.data, contentType: "image/webp", width: processed.width, height: processed.height, filename: null, ext: "webp" };
  } else {
    if (raw.byteLength === 0) throw invalid("The file is empty.");
    // The stored type is fixed: what the browser claimed is never trusted for serving.
    stored = { data: raw, contentType: "application/octet-stream", width: 0, height: 0, filename: cleanFilename(rawFilename), ext: "bin" };
  }
  signal?.throwIfAborted();
  const key = `attachments/${randomUUID()}.${stored.ext}`;
  // Row first: if the upload fails afterwards, the unlinked row lets the sweeper clean up.
  // Checks and insert are serialised per person, so parallel uploads can't slip past the caps.
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`upload:${userId}`}, 0))`);
    const [{ unlinked }] = await tx.select({ unlinked: count() }).from(attachment)
      .where(and(eq(attachment.uploaderId, userId), isNull(attachment.messageId)));
    if (unlinked >= maximumPending) throw new AppError("rate_limited", "Send or remove your pending attachments first.");
    const [{ today }] = await tx.select({ today: sum(attachment.size).mapWith(Number) }).from(attachment)
      .where(and(eq(attachment.uploaderId, userId), gt(attachment.createdAt, new Date(Date.now() - 86_400_000))));
    if ((today ?? 0) + stored.data.byteLength > DAILY_UPLOAD_BYTES) {
      throw new AppError("rate_limited", `You can upload at most ${mb(DAILY_UPLOAD_BYTES)} per day.`);
    }
    const [created] = await tx.insert(attachment).values({
      channelId, uploaderId: userId, key, contentType: stored.contentType, filename: stored.filename,
      size: stored.data.byteLength, width: stored.width, height: stored.height,
    }).returning({ id: attachment.id });
    return created;
  });
  try {
    await storage.put(key, stored.data as Uint8Array<ArrayBuffer>, stored.contentType, signal);
  } catch {
    // Keep the unlinked row: a write can succeed remotely despite a lost response.
    // The sweeper will remove both the unreachable object and its quota reservation.
    throw new AppError("conflict", "The file couldn't be stored. Try again.");
  }
  return { id: row.id, width: stored.width, height: stored.height, filename: stored.filename, size: stored.data.byteLength };
}

export const attachmentIds = z.array(uuid).max(MAX_ATTACHMENTS_PER_MESSAGE, `Attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);

/** Links the sender's own unsent uploads from the same channel to a new message. */
export async function linkAttachments(tx: Db, userId: string, channelId: string, messageId: string, ids: string[]) {
  if (ids.length === 0) return;
  const linked = await tx.update(attachment).set({ messageId, linkedAt: new Date() })
    .where(and(inArray(attachment.id, ids), eq(attachment.uploaderId, userId), eq(attachment.channelId, channelId), isNull(attachment.messageId), isNull(attachment.linkedAt)))
    .returning({ id: attachment.id });
  if (linked.length !== new Set(ids).size) throw invalid("An attachment is no longer available. Remove it and attach it again.");
}

export async function attachmentsFor(messageIds: string[]): Promise<Map<string, AttachmentView[]>> {
  const byMessage = new Map<string, AttachmentView[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db.select({
    id: attachment.id, messageId: attachment.messageId, width: attachment.width, height: attachment.height,
    filename: attachment.filename, size: attachment.size,
  })
    .from(attachment).where(inArray(attachment.messageId, messageIds)).orderBy(attachment.id);
  for (const { messageId, ...view } of rows) byMessage.set(messageId!, [...(byMessage.get(messageId!) ?? []), view]);
  return byMessage;
}

/** Streams an attachment to a member of its channel. Everyone else gets "not found". */
export async function readAttachment(userId: string, rawId: unknown): Promise<Response> {
  const storage = requireStorage();
  const id = parse(uuid, rawId);
  const [row] = await db.select({ key: attachment.key, contentType: attachment.contentType, filename: attachment.filename, channelId: message.channelId })
    .from(attachment).innerJoin(message, eq(message.id, attachment.messageId)).where(eq(attachment.id, id));
  if (!row) throw notFound("Attachment not found.");
  await requireChannel(db, row.channelId, userId);
  const res = await storage.read(row.key);
  if (!res.ok || !res.body) {
    console.error("[media] read failed", res.status);
    throw notFound("Attachment not found.");
  }
  return new Response(res.body, {
    headers: {
      "Content-Type": row.contentType,
      ...(res.headers.has("Content-Length") && { "Content-Length": res.headers.get("Content-Length")! }),
      // Short, so someone removed from the channel stops seeing cached copies soon.
      "Cache-Control": "private, max-age=300",
      // Files are always downloads: an uploaded HTML or SVG file must never render on this origin.
      "Content-Disposition": row.filename
        ? `attachment; filename="download"; filename*=UTF-8''${rfc5987(row.filename)}`
        : `inline; filename="${id}.webp"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

/**
 * Deletes objects whose message, channel, community or author is gone (right away), and uploads that
 * were never sent (after an hour). They are unreachable from the moment they are unlinked.
 */
let sweeping: Promise<number> | null = null;

export function sweepAttachments(now = Date.now()): Promise<number> {
  // Single flight: uploads trigger sweeps too, and overlapping runs would delete the same objects twice.
  sweeping ??= sweep(now).finally(() => (sweeping = null));
  return sweeping;
}

async function sweep(now: number): Promise<number> {
  if (!storage) return 0;
  const stale = await db.select({ id: attachment.id, key: attachment.key }).from(attachment)
    .where(and(isNull(attachment.messageId), or(isNotNull(attachment.linkedAt), lt(attachment.createdAt, new Date(now - UNLINKED_TTL_MS))))).limit(200);
  const removed: string[] = [];
  await Promise.all(stale.map(async ({ id, key }) => {
    if (await storage.remove(key).catch(() => false)) removed.push(id);
  }));
  if (removed.length) await db.delete(attachment).where(and(inArray(attachment.id, removed), isNull(attachment.messageId)));
  return removed.length;
}

let sweeper: ReturnType<typeof setInterval> | undefined;
export function startMediaSweeper() {
  if (!storage || sweeper) return;
  const run = () => void sweepAttachments().catch((error: unknown) => console.error("[media] sweep failed", error));
  sweeper = setInterval(run, 15 * 60_000);
  sweeper.unref();
  run();
}
