// Image attachments in S3-compatible object storage (Cloudflare R2 by default; docs/DECISIONS.md D9).
// Every upload is decoded and re-encoded server-side: only real raster images survive, and EXIF/GPS
// metadata is dropped. Objects are only ever served through an access-checked route.
import { randomUUID } from "node:crypto";
import { and, count, eq, gt, inArray, isNotNull, isNull, lt, or, sql, sum } from "drizzle-orm";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";
import { db } from "@/db";
import { attachment, message } from "@/db/schema";
import { ACCEPTED_IMAGE_TYPES, AVATAR_DIMENSION, AVATAR_RAW_BYTES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_FILE_BYTES, MAX_ARCHIVE_ATTACHMENTS } from "@/lib/limits";
import { assetDimension, assetRawLimit, type AssetRef } from "@/lib/community-assets";
import { requireChannel, type Db } from "./access";
import { AppError, invalid, notFound } from "./errors";
import { consume } from "./limits";
import { configuredAttachmentStorage } from "./attachment-storage";
import { scanAttachment } from "./attachment-scanner";
import { Permission } from "./permissions";
import { assertActiveUser } from "./instance-policy";
import { parse, uuid } from "./validation";
import { cleanFilename } from "@/lib/filename";

export { cleanFilename };

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

export function requireStorage() {
  if (!storage) throw new AppError("forbidden", "Media uploads aren't enabled on this instance.");
  return storage;
}

interface ImageProcessingOptions { maximumDimension?: number; maximumFrames?: number; maximumPixels?: number; square?: boolean }

/** Decodes, validates and re-encodes an image to WebP without metadata. */
export async function processImage(input: Uint8Array, { maximumDimension = MAX_DIMENSION, maximumFrames = MAX_FRAMES, maximumPixels = MAX_TOTAL_PIXELS, square = false }: ImageProcessingOptions = {}): Promise<{ data: Buffer; width: number; height: number }> {
  if (input.byteLength === 0) throw invalid("The file is empty.");
  if (input.byteLength > MAX_ATTACHMENT_BYTES) throw invalid(`Images can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  // sharp applies the pixel limit to the whole animation, a second guard for the check below.
  const options = { animated: true, limitInputPixels: maximumPixels, failOn: "error" } as const;
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
  if (frames > maximumFrames) throw invalid(maximumFrames === 1 ? "Community emoji and stickers must be static images." : `Animated images can have at most ${maximumFrames} frames.`);
  if ((meta.width ?? 0) * (meta.pageHeight ?? meta.height ?? 0) * frames > maximumPixels) throw invalid("That image is too large to process.");
  try {
    const data = await sharp(input, options)
      .autoOrient()
      // Square: the client crops, but the stored picture is centre-cropped again so it is always square.
      .resize({ width: maximumDimension, height: maximumDimension, fit: square ? "cover" : "inside", withoutEnlargement: !square })
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
/** A slow-trickle body would hold an upload slot: the whole body must arrive within the deadline, without long stalls. */
export const UPLOAD_READ_DEADLINE_MS = 60_000;
export const UPLOAD_READ_STALL_MS = 15_000;

export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number, { deadlineMs = UPLOAD_READ_DEADLINE_MS, stallMs = UPLOAD_READ_STALL_MS } = {}): Promise<Uint8Array> {
  if (!body) throw invalid("The upload is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + deadlineMs;
  const reader = body.getReader();
  const read = () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(invalid("The upload was too slow. Check your connection and try again.")), Math.max(0, Math.min(stallMs, deadline - Date.now()))); });
    return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
  };
  try {
    for (let r = await read(); !r.done; r = await read()) {
      const chunk = r.value;
      size += chunk.byteLength;
      if (size > limit) throw invalid(`The upload is larger than it announced.`);
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks);
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

/**
 * Stores end-to-end encrypted DM ciphertext as is. It cannot be scanned or decoded: the server never has
 * the key. The caller checks conversation membership; sending links it to a message.
 */
export async function uploadDmCiphertext(userId: string, contentLength: number, body: (limit: number) => Promise<Uint8Array>): Promise<AttachmentView> {
  requireStorage();
  await consume(`upload:${userId}`, UPLOAD_LIMIT.max, UPLOAD_LIMIT.windowMs);
  if (!Number.isFinite(contentLength) || contentLength <= 0) throw invalid("The upload needs a Content-Length.");
  if (contentLength > MAX_FILE_BYTES) throw invalid(`Files can be at most ${mb(MAX_FILE_BYTES)}.`);
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) throw new AppError("rate_limited", "The server is busy with other uploads. Try again in a moment.");
  activeUploads += 1;
  try {
    const data = await body(contentLength);
    if (data.byteLength === 0) throw invalid("The file is empty.");
    return await persistUpload(userId, null, { data, contentType: "application/octet-stream", width: 0, height: 0, filename: null, ext: "bin" });
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

/** Static community library uploads use the same private reservation, scanner and processing slots. */
export async function stageCommunityAssetAttachment(userId: string, kind: AssetRef["kind"], raw: Uint8Array, signal: AbortSignal, forArchive = false): Promise<AttachmentView> {
  signal.throwIfAborted();
  await assertActiveUser(userId);
  if (raw.byteLength === 0 || raw.byteLength > assetRawLimit(kind)) throw invalid("The community image exceeds its upload limit.");
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) throw new AppError("rate_limited", "The server is busy with other uploads. Try again in a moment.");
  activeUploads += 1;
  try {
    return await storeUpload(userId, null, true, null, raw, forArchive ? MAX_ARCHIVE_ATTACHMENTS : MAX_UNLINKED_PER_USER, signal, { maximumDimension: assetDimension(kind), maximumFrames: 1, maximumPixels: 1_048_576 });
  } finally { activeUploads -= 1; }
}

/** A static, square profile picture; linked to the account by `setAvatar`. */
export async function stageAvatarAttachment(userId: string, raw: Uint8Array, signal: AbortSignal): Promise<AttachmentView> {
  signal.throwIfAborted();
  if (raw.byteLength === 0 || raw.byteLength > AVATAR_RAW_BYTES) throw invalid(`Profile pictures can be at most ${mb(AVATAR_RAW_BYTES)}.`);
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) throw new AppError("rate_limited", "The server is busy with other uploads. Try again in a moment.");
  activeUploads += 1;
  try {
    return await storeUpload(userId, null, true, null, raw, MAX_UNLINKED_PER_USER, signal, { maximumDimension: AVATAR_DIMENSION, maximumFrames: 1, maximumPixels: MAX_DIMENSION * MAX_DIMENSION, square: true });
  } finally { activeUploads -= 1; }
}

async function storeUpload(userId: string, channelId: string | null, image: boolean, rawFilename: string | null, raw: Uint8Array, maximumPending = MAX_UNLINKED_PER_USER, signal?: AbortSignal, imageOptions?: ImageProcessingOptions): Promise<AttachmentView> {
  requireStorage();
  await scanAttachment(raw);
  let stored: StoredUpload;
  if (image) {
    const processed = await processImage(raw, imageOptions);
    stored = { data: processed.data, contentType: "image/webp", width: processed.width, height: processed.height, filename: null, ext: "webp" };
  } else {
    if (raw.byteLength === 0) throw invalid("The file is empty.");
    // The stored type is fixed: what the browser claimed is never trusted for serving.
    stored = { data: raw, contentType: "application/octet-stream", width: 0, height: 0, filename: cleanFilename(rawFilename), ext: "bin" };
  }
  signal?.throwIfAborted();
  return persistUpload(userId, channelId, stored, maximumPending, signal);
}

type StoredUpload = { data: Uint8Array; contentType: string; width: number; height: number; filename: string | null; ext: string };
/** Reserves quota and writes the object; shared by scanned community uploads and opaque DM ciphertext. */
export async function persistUpload(userId: string, channelId: string | null, stored: StoredUpload, maximumPending = MAX_UNLINKED_PER_USER, signal?: AbortSignal): Promise<AttachmentView> {
  const storage = requireStorage();
  const key = `attachments/${randomUUID()}.${stored.ext}`;
  // Row first: if the upload fails afterwards, the unlinked row lets the sweeper clean up.
  // Checks and insert are serialised per person, so parallel uploads can't slip past the caps.
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`upload:${userId}`}, 0))`);
    const [{ unlinked }] = await tx.select({ unlinked: count() }).from(attachment)
      .where(and(eq(attachment.uploaderId, userId), isNull(attachment.messageId), isNull(attachment.dmMessageId), isNull(attachment.assetId), isNull(attachment.avatarUserId)));
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
    .where(and(inArray(attachment.id, ids), eq(attachment.uploaderId, userId), eq(attachment.channelId, channelId), isNull(attachment.messageId), isNull(attachment.assetId), isNull(attachment.linkedAt)))
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
  const stale = await db.transaction(async (tx) => {
    const eligible = and(isNull(attachment.messageId), isNull(attachment.dmMessageId), isNull(attachment.assetId), isNull(attachment.avatarUserId), or(isNotNull(attachment.linkedAt), lt(attachment.createdAt, new Date(now - UNLINKED_TTL_MS))));
    const rows = await tx.select({ id: attachment.id }).from(attachment).where(eligible).limit(200).for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    // Claim before storage I/O so a concurrent sender cannot reattach an object being removed.
    return tx.update(attachment).set({ linkedAt: sql`coalesce(${attachment.linkedAt}, now())` })
      .where(and(inArray(attachment.id, rows.map((row) => row.id)), eligible)).returning({ id: attachment.id, key: attachment.key });
  });
  const removed: string[] = [];
  await Promise.all(stale.map(async ({ id, key }) => {
    if (await storage.remove(key).catch(() => false)) removed.push(id);
  }));
  if (removed.length) await db.delete(attachment).where(and(inArray(attachment.id, removed), isNull(attachment.messageId), isNull(attachment.dmMessageId), isNull(attachment.assetId), isNull(attachment.avatarUserId), isNotNull(attachment.linkedAt)));
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
