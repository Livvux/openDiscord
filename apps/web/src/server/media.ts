// Image attachments in S3-compatible object storage (Cloudflare R2 by default; docs/DECISIONS.md D9).
// Every upload is decoded and re-encoded server-side: only real raster images survive, and EXIF/GPS
// metadata is dropped. Objects are only ever served through an access-checked route.
import { randomUUID } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { and, count, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";
import { db } from "@/db";
import { attachment, message } from "@/db/schema";
import { ACCEPTED_IMAGE_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/limits";
import { requireChannel, type Db } from "./access";
import { AppError, invalid, notFound } from "./errors";
import { consume } from "./limits";
import { Permission } from "./permissions";
import { parse, uuid } from "./validation";

export interface AttachmentView { id: string; width: number; height: number }

const UPLOAD_LIMIT = { max: 10, windowMs: 60_000 };
/** Uploaded but not yet sent; bounds storage one account can occupy without posting. */
const MAX_UNLINKED_PER_USER = 20;
const MAX_DIMENSION = 4096;
const MAX_FRAMES = 100;
/** Decoded size across all frames, so animations can't multiply memory use. */
const MAX_TOTAL_PIXELS = 50_000_000;
const UNLINKED_TTL_MS = 60 * 60_000;
const DECODABLE = new Set(["jpeg", "png", "webp", "gif"]);

const storage = (() => {
  const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return {
    client: new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" }),
    url: (key: string) => `${R2_ENDPOINT.replace(/\/$/, "")}/${R2_BUCKET}/${key}`,
  };
})();

/** Uploads are offered only when object storage is configured. */
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
      throw invalid(`Images can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function uploadAttachment(userId: string, rawChannelId: unknown, contentType: string | null, contentLength: number, body: (limit: number) => Promise<Uint8Array>): Promise<AttachmentView> {
  const { client, url } = requireStorage();
  const channelId = parse(uuid, rawChannelId);
  consume(`upload:${userId}`, UPLOAD_LIMIT.max, UPLOAD_LIMIT.windowMs);
  if (!contentType || !(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(contentType.split(";")[0].trim())) {
    throw invalid("Use a PNG, JPEG, WebP or GIF image.");
  }
  // Checked before reading the body, so oversized uploads are never buffered.
  if (!Number.isFinite(contentLength) || contentLength <= 0) throw invalid("The upload needs a Content-Length.");
  if (contentLength > MAX_ATTACHMENT_BYTES) throw invalid(`Images can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  await requireChannel(db, channelId, userId, Permission.SendMessages);
  const [{ unlinked }] = await db.select({ unlinked: count() }).from(attachment)
    .where(and(eq(attachment.uploaderId, userId), isNull(attachment.messageId)));
  if (unlinked >= MAX_UNLINKED_PER_USER) throw new AppError("rate_limited", "Send or remove your pending images first.");

  const image = await processImage(await body(contentLength));
  const key = `attachments/${randomUUID()}.webp`;
  // Row first: if the upload fails afterwards, the unlinked row lets the sweeper clean up.
  const [row] = await db.insert(attachment).values({
    channelId, uploaderId: userId, key, contentType: "image/webp", size: image.data.byteLength, width: image.width, height: image.height,
  }).returning({ id: attachment.id });
  const res = await client.fetch(url(key), { method: "PUT", body: new Uint8Array(image.data), headers: { "Content-Type": "image/webp" } });
  if (!res.ok) {
    await db.delete(attachment).where(eq(attachment.id, row.id));
    console.error("[media] upload failed", res.status, await res.text().catch(() => ""));
    throw new AppError("conflict", "The image couldn't be stored. Try again.");
  }
  return { id: row.id, width: image.width, height: image.height };
}

export const attachmentIds = z.array(uuid).max(MAX_ATTACHMENTS_PER_MESSAGE, `Attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} images.`);

/** Links the sender's own unsent uploads from the same channel to a new message. */
export async function linkAttachments(tx: Db, userId: string, channelId: string, messageId: string, ids: string[]) {
  if (ids.length === 0) return;
  const linked = await tx.update(attachment).set({ messageId, linkedAt: new Date() })
    .where(and(inArray(attachment.id, ids), eq(attachment.uploaderId, userId), eq(attachment.channelId, channelId), isNull(attachment.messageId), isNull(attachment.linkedAt)))
    .returning({ id: attachment.id });
  if (linked.length !== new Set(ids).size) throw invalid("An image is no longer available. Remove it and attach it again.");
}

export async function attachmentsFor(messageIds: string[]): Promise<Map<string, AttachmentView[]>> {
  const byMessage = new Map<string, AttachmentView[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db.select({ id: attachment.id, messageId: attachment.messageId, width: attachment.width, height: attachment.height })
    .from(attachment).where(inArray(attachment.messageId, messageIds)).orderBy(attachment.id);
  for (const { messageId, ...view } of rows) byMessage.set(messageId!, [...(byMessage.get(messageId!) ?? []), view]);
  return byMessage;
}

/** Streams an attachment to a member of its channel. Everyone else gets "not found". */
export async function readAttachment(userId: string, rawId: unknown): Promise<Response> {
  const { client, url } = requireStorage();
  const id = parse(uuid, rawId);
  const [row] = await db.select({ key: attachment.key, contentType: attachment.contentType, channelId: message.channelId })
    .from(attachment).innerJoin(message, eq(message.id, attachment.messageId)).where(eq(attachment.id, id));
  if (!row) throw notFound("Attachment not found.");
  await requireChannel(db, row.channelId, userId);
  const res = await client.fetch(url(row.key));
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
      "Content-Disposition": `inline; filename="${id}.webp"`,
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
export async function sweepAttachments(now = Date.now()): Promise<number> {
  if (!storage) return 0;
  const { client, url } = storage;
  const stale = await db.select({ id: attachment.id, key: attachment.key }).from(attachment)
    .where(and(isNull(attachment.messageId), or(isNotNull(attachment.linkedAt), lt(attachment.createdAt, new Date(now - UNLINKED_TTL_MS))))).limit(200);
  const removed: string[] = [];
  await Promise.all(stale.map(async ({ id, key }) => {
    const res = await client.fetch(url(key), { method: "DELETE" }).catch(() => null);
    if (res && (res.ok || res.status === 404)) removed.push(id);
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
