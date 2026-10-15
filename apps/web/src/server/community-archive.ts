import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, lte, sum } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { attachment, mention, message, session, user } from "@/db/schema";
import { MAX_ARCHIVE_ATTACHMENTS, MAX_ARCHIVE_MEDIA_BYTES, MAX_ARCHIVE_METADATA_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MAX_FILE_BYTES } from "@/lib/limits";
import { requireMember } from "./access";
import { configuredAttachmentStorage } from "./attachment-storage";
import { ARCHIVE_LIMITS, decodeCommunityArchive, encodeCommunityArchive } from "./community-archive-codec";
import { communityExportSchema, exportCommunity, importCommunity, MAX_IMPORT_MESSAGES } from "./community-export";
import { AppError, forbidden, invalid } from "./errors";
import { assertActiveUser } from "./instance-policy";
import { consume } from "./limits";
import { stageArchiveAttachment } from "./media";
import type { SessionUser } from "./session";
import { parse, uuid } from "./validation";

type Actor = Pick<SessionUser, "id" | "sessionId">;
const CHUNK_BYTES = 64 * 1024;
const BATCH = 500;
const DURATION = 5 * 60_000;
const messageSchema = communityExportSchema.shape.messages.element.extend({ attachments: z.number().int().min(0).max(MAX_ATTACHMENTS_PER_MESSAGE) });
const dataSchema = communityExportSchema.extend({ exportedAt: z.iso.datetime({ offset: true }), truncated: z.boolean() });
const recordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), format: z.literal("opendiscord.community-archive"), version: z.literal(2), data: dataSchema.refine((data) => data.messages.length === 0) }).strict(),
  z.object({ type: z.literal("message"), data: messageSchema }).strict(),
  z.object({ type: z.literal("file"), id: uuid, messageKey: z.string().min(1).max(64), size: z.number().int().positive().max(MAX_FILE_BYTES), contentType: z.enum(["image/webp", "application/octet-stream"]), filename: z.string().max(128).nullable() }).strict(),
  z.object({ type: z.literal("chunk"), index: z.number().int().min(0), data: z.string().min(4).max(87384) }).strict(),
  z.object({ type: z.literal("file-end"), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal("end"), messages: z.number().int().min(0).max(MAX_IMPORT_MESSAGES), attachments: z.number().int().min(0).max(MAX_ARCHIVE_ATTACHMENTS), bytes: z.number().int().min(0).max(MAX_ARCHIVE_MEDIA_BYTES) }).strict(),
]);
type Record = z.infer<typeof recordSchema>;

async function activeActor(actor: Actor) {
  const [current] = await db.select({ id: session.id }).from(session)
    .where(and(eq(session.id, actor.sessionId), eq(session.userId, actor.id), gt(session.expiresAt, new Date())));
  if (!current) throw new AppError("unauthorized", "Sign in again before transferring a community.");
  await assertActiveUser(actor.id);
}
async function owner(actor: Actor, communityId: string) {
  await activeActor(actor);
  const access = await requireMember(db, communityId, actor.id);
  if (!access.authority.isOwner) throw forbidden("Only the owner can export a community.");
}
const deadline = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(DURATION)]) : AbortSignal.timeout(DURATION);

/** Preflight owner/cap checks happen before the route sends any archive bytes. */
export async function exportCommunityArchive(actor: Actor, rawId: unknown, inputSignal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const communityId = parse(uuid, rawId);
  const signal = deadline(inputSignal);
  await owner(actor, communityId);
  const data = await exportCommunity(actor.id, communityId, false);
  const channels = data.channels.map((ch) => ch.key);
  const [newest] = await db.select({ id: message.id }).from(message).where(inArray(message.channelId, channels)).orderBy(desc(message.id)).limit(1);
  const boundary = newest ? await db.select({ id: message.id }).from(message)
    .where(and(inArray(message.channelId, channels), lte(message.id, newest.id))).orderBy(desc(message.id)).offset(MAX_IMPORT_MESSAGES - 1).limit(2) : [];
  const lower = boundary[0]?.id;
  data.truncated = boundary.length > 1;
  const scope = and(inArray(message.channelId, channels), newest ? lte(message.id, newest.id) : eq(message.id, "00000000-0000-0000-0000-000000000000"), lower ? gte(message.id, lower) : undefined);
  const selectedIds = new Set((await db.select({ id: message.id }).from(message).where(scope).limit(MAX_IMPORT_MESSAGES)).map((row) => row.id));
  const [totals] = await db.select({ files: count(), bytes: sum(attachment.size).mapWith(Number) }).from(attachment).innerJoin(message, eq(message.id, attachment.messageId)).where(scope);
  if (totals.files > MAX_ARCHIVE_ATTACHMENTS || (totals.bytes ?? 0) > MAX_ARCHIVE_MEDIA_BYTES) throw invalid("Complete archives support at most 4096 files and 256 MiB of attachment bytes. Use an operator backup for larger communities.");
  const storage = configuredAttachmentStorage();
  if (totals.files && !storage) throw forbidden("Attachment storage must be configured to export files.");
  const header: Record = { type: "header", format: "opendiscord.community-archive", version: 2, data };
  let metadataBytes = Buffer.byteLength(JSON.stringify(header));
  parse(recordSchema, header);
  if (metadataBytes > ARCHIVE_LIMITS.recordBytes) throw invalid("The community structure exceeds the archive record limit.");

  async function* records(): AsyncGenerator<Record> {
    let messages = 0; let files = 0; let bytes = 0; let cursor: string | undefined;
    yield header;
    while (newest) {
      signal.throwIfAborted();
      await owner(actor, communityId);
      const batch = await db.select({ m: message, author: user.name }).from(message).innerJoin(user, eq(user.id, message.authorId))
        .where(and(scope, cursor ? gt(message.id, cursor) : undefined)).orderBy(asc(message.id)).limit(BATCH);
      if (!batch.length) break;
      const ids = batch.map((row) => row.m.id);
      const [mentions, attachments] = await Promise.all([
        db.select({ messageId: mention.messageId, userId: user.id, name: user.name }).from(mention).innerJoin(user, eq(user.id, mention.userId)).where(inArray(mention.messageId, ids)),
        db.select().from(attachment).where(inArray(attachment.messageId, ids)).orderBy(asc(attachment.id)),
      ]);
      for (const { m, author } of batch) {
        if (++messages > MAX_IMPORT_MESSAGES) throw invalid("The archive message limit was exceeded.");
        const names = new Map(mentions.filter((item) => item.messageId === m.id).map((item) => [item.userId, item.name]));
        const linked = attachments.filter((file) => file.messageId === m.id);
        const row: Record = { type: "message", data: {
          key: m.id, channelKey: m.channelId, author: m.importedAuthor ?? author,
          content: m.content.replace(/<@([A-Za-z0-9_-]{1,64})>/g, (_, id: string) => `@${names.get(id) ?? "member"}`),
          createdAt: m.createdAt.toISOString(), editedAt: m.editedAt?.toISOString() ?? null, pinned: m.pinnedAt !== null,
          replyToKey: m.replyToId && selectedIds.has(m.replyToId) ? m.replyToId : null,
          threadKey: m.threadId && selectedIds.has(m.threadId) ? m.threadId : null, attachments: linked.length,
        } };
        parse(recordSchema, row);
        metadataBytes += Buffer.byteLength(JSON.stringify(row));
        if (metadataBytes > MAX_ARCHIVE_METADATA_BYTES) throw invalid("The archive metadata limit was exceeded.");
        yield row;
        for (const file of linked) {
          signal.throwIfAborted();
          await owner(actor, communityId);
          if (!storage || ++files > MAX_ARCHIVE_ATTACHMENTS || bytes + file.size > MAX_ARCHIVE_MEDIA_BYTES) throw invalid("The archive attachment limit was exceeded.");
          const start: Record = { type: "file", id: file.id, messageKey: m.id, size: file.size, contentType: file.filename ? "application/octet-stream" : "image/webp", filename: file.filename };
          parse(recordSchema, start);
          metadataBytes += Buffer.byteLength(JSON.stringify(start));
          if (metadataBytes > MAX_ARCHIVE_METADATA_BYTES) throw invalid("The archive metadata limit was exceeded.");
          yield start;
          const response = await storage.read(file.key, signal);
          if (!response.ok || !response.body) { await response.body?.cancel(); throw invalid("An attachment is missing; the complete export cannot continue."); }
          const reader = response.body.getReader();
          const hash = createHash("sha256"); let size = 0; let index = 0;
          try {
            while (true) {
              signal.throwIfAborted();
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > file.size) throw invalid("An attachment has an unexpected size.");
              hash.update(next.value);
              for (let offset = 0; offset < next.value.byteLength; offset += CHUNK_BYTES) {
                yield { type: "chunk", index: index++, data: Buffer.from(next.value.subarray(offset, offset + CHUNK_BYTES)).toString("base64") };
              }
            }
            if (size !== file.size) throw invalid("An attachment is incomplete.");
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          bytes += size;
          const end: Record = { type: "file-end", sha256: hash.digest("hex") };
          metadataBytes += Buffer.byteLength(JSON.stringify(end));
          if (metadataBytes > MAX_ARCHIVE_METADATA_BYTES) throw invalid("The archive metadata limit was exceeded.");
          yield end;
        }
      }
      cursor = batch[batch.length - 1].m.id;
    }
    await owner(actor, communityId);
    const end: Record = { type: "end", messages, attachments: files, bytes };
    metadataBytes += Buffer.byteLength(JSON.stringify(end));
    if (metadataBytes > MAX_ARCHIVE_METADATA_BYTES) throw invalid("The archive metadata limit was exceeded.");
    yield end;
  }
  return encodeCommunityArchive(records(), undefined, signal);
}

let importingArchive = false;
/** Stage privately; commit only after the complete gzip stream and reference graph validate. */
export async function importCommunityArchive(actor: Actor, body: ReadableStream<Uint8Array>, inputSignal?: AbortSignal): Promise<string> {
  let admitted = false;
  const signal = deadline(inputSignal);
  try {
    await activeActor(actor);
    if (importingArchive) throw new AppError("rate_limited", "Another archive import is running. Try again shortly.");
    importingArchive = true;
    admitted = true;
    await consume(`archive-import:${actor.id}`, 1, 10 * 60_000);
    let header: z.infer<typeof dataSchema> | undefined;
    const messages: z.infer<typeof messageSchema>[] = [];
    const messageIds = new Set<string>(); const fileIds = new Set<string>();
    const staged: { id: string; messageKey: string }[] = [];
    let metadataBytes = 0; let bytes = 0; let complete = false; let messageFiles = 0;
    let current: { record: Extract<Record, { type: "file" }>; chunks: Buffer[]; size: number; index: number; hash: ReturnType<typeof createHash> } | undefined;
    for await (const raw of decodeCommunityArchive(body, undefined, signal)) {
      signal.throwIfAborted();
      if (complete) throw invalid("The archive contains records after its end marker.");
      const record = parse(recordSchema, raw);
      if (record.type !== "chunk") {
        metadataBytes += Buffer.byteLength(JSON.stringify(record));
        if (metadataBytes > MAX_ARCHIVE_METADATA_BYTES) throw invalid("The archive metadata limit was exceeded.");
      }
      if (record.type === "header") {
        if (header || messages.length) throw invalid("The archive contains multiple headers.");
        header = record.data;
        continue;
      }
      if (!header) throw invalid("The archive header is missing.");
      if (record.type === "message") {
        if (current || (messages.length && messageFiles !== messages[messages.length - 1].attachments)) throw invalid("An archived message has incomplete files.");
        if (messages.length >= MAX_IMPORT_MESSAGES || messageIds.has(record.data.key)) throw invalid("The archive contains duplicate or too many messages.");
        if (!header.channels.some((ch) => ch.key === record.data.channelKey)) throw invalid("An archived message has an unknown channel.");
        messages.push(record.data); messageIds.add(record.data.key); messageFiles = 0;
      } else if (record.type === "file") {
        const parent = messages[messages.length - 1];
        if (current || !parent || parent.key !== record.messageKey || messageFiles >= parent.attachments || fileIds.has(record.id)) throw invalid("Invalid archived attachment references.");
        if (fileIds.size >= MAX_ARCHIVE_ATTACHMENTS || bytes + record.size > MAX_ARCHIVE_MEDIA_BYTES || (record.contentType === "image/webp" && record.size > MAX_ATTACHMENT_BYTES)) throw invalid("The archive attachment limit was exceeded.");
        await activeActor(actor);
        fileIds.add(record.id);
        current = { record, chunks: [], size: 0, index: 0, hash: createHash("sha256") };
      } else if (record.type === "chunk") {
        if (!current || record.index !== current.index++) throw invalid("Archived file chunks are out of order.");
        const chunk = Buffer.from(record.data, "base64");
        if (chunk.toString("base64") !== record.data || chunk.length > CHUNK_BYTES) throw invalid("Invalid archived file encoding.");
        current.size += chunk.length;
        if (current.size > current.record.size) throw invalid("An archived file exceeds its declared size.");
        current.hash.update(chunk); current.chunks.push(chunk);
      } else if (record.type === "file-end") {
        if (!current || current.size !== current.record.size || current.hash.digest("hex") !== record.sha256) throw invalid("An archived file is incomplete or corrupted.");
        const file = await stageArchiveAttachment(actor.id, current.record.contentType === "image/webp", current.record.filename, Buffer.concat(current.chunks, current.size), signal);
        staged.push({ id: file.id, messageKey: current.record.messageKey });
        bytes += current.size; current = undefined; messageFiles++;
      } else {
        if (current || (messages.length && messageFiles !== messages[messages.length - 1].attachments) || record.messages !== messages.length || record.attachments !== staged.length || record.bytes !== bytes) throw invalid("The archive end marker does not match its contents.");
        complete = true;
      }
    }
    if (!header || !complete) throw invalid("The complete archive end marker is missing.");
    signal.throwIfAborted();
    return await importCommunity(actor.id, { ...header, messages }, { sessionId: actor.sessionId, attachments: staged });
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Database errors can contain imported message parameters; never log that payload.
    console.error("[archive] import could not be confirmed");
    throw new AppError("conflict", "Import confirmation failed. Check your communities before retrying.");
  } finally {
    // Never eagerly delete objects here: COMMIT may have succeeded before its acknowledgement was lost.
    if (admitted) importingArchive = false;
    await body.cancel().catch(() => {});
  }
}
