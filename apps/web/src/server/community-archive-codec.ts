import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { MAX_ARCHIVE_COMPRESSED_BYTES } from "@/lib/limits";
import { AppError } from "./errors";

export const ARCHIVE_LIMITS = {
  compressedBytes: MAX_ARCHIVE_COMPRESSED_BYTES,
  decodedBytes: 400 * 1024 * 1024,
  recordBytes: 4 * 1024 * 1024,
};
const invalid = () => new AppError("invalid", "The archive is invalid, incomplete or exceeds its size limits.");

/** Native gzip framing; downstream cancellation destroys the producer through pipeline. */
export function encodeCommunityArchive(records: AsyncIterable<unknown>, limits = ARCHIVE_LIMITS, signal?: AbortSignal): ReadableStream<Uint8Array> {
  async function* lines() {
    let total = 0;
    for await (const record of records) {
      signal?.throwIfAborted();
      const json = JSON.stringify(record);
      if (json === undefined) throw invalid();
      const bytes = Buffer.from(`${json}\n`);
      total += bytes.length;
      if (bytes.length - 1 > limits.recordBytes || total > limits.decodedBytes) throw invalid();
      yield bytes;
    }
  }
  const source = Readable.from(lines(), { objectMode: false, highWaterMark: 64 * 1024 });
  const gzip = createGzip({ chunkSize: 64 * 1024 });
  let compressedBytes = 0;
  const bounded = new Transform({
    transform(chunk: unknown, _encoding, callback) {
      if (!Buffer.isBuffer(chunk)) return callback(invalid());
      compressedBytes += chunk.length;
      if (compressedBytes > limits.compressedBytes) return callback(invalid());
      callback(null, chunk);
    },
  });
  // The body consumer receives the stream error. Observe the pipeline rejection too.
  void pipeline(source, gzip, bounded, { signal }).catch(() => {});
  return Readable.toWeb(bounded) as ReadableStream<Uint8Array>;
}

/** Consume to completion before committing an import: gzip checksum errors can arrive after records. */
export async function* decodeCommunityArchive(
  body: ReadableStream<Uint8Array>,
  limits = ARCHIVE_LIMITS,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const cancelRead = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancelRead, { once: true });
  async function* compressed() {
    let total = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const next = await reader.read();
        signal?.throwIfAborted();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > limits.compressedBytes) throw invalid();
        yield next.value;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const source = Readable.from(compressed(), { objectMode: false, highWaterMark: 64 * 1024 });
  const gunzip = createGunzip({ chunkSize: 64 * 1024 });
  void pipeline(source, gunzip, { signal }).catch(() => {});
  let total = 0;
  let pendingBytes = 0;
  let pending: Buffer[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of gunzip) {
      if (!Buffer.isBuffer(chunk)) throw invalid();
      total += chunk.length;
      if (total > limits.decodedBytes) throw invalid();
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        pendingBytes += part.length;
        if (pendingBytes > limits.recordBytes) throw invalid();
        pending.push(part);
        if (newline === -1) break;
        const line = Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        yield JSON.parse(decoder.decode(line));
        offset = newline + 1;
      }
    }
    if (pendingBytes !== 0) throw invalid();
  } catch {
    // zlib/JSON errors must not echo private archive contents into route error logs.
    throw invalid();
  } finally {
    signal?.removeEventListener("abort", cancelRead);
    await reader.cancel().catch(() => {});
    source.destroy();
    gunzip.destroy();
  }
}
