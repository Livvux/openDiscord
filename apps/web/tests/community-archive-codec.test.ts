import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeCommunityArchive, encodeCommunityArchive } from "@/server/community-archive-codec";

function body(data: Uint8Array, chunk = data.length): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset === data.length) return controller.close();
    controller.enqueue(data.subarray(offset, offset += Math.min(chunk, data.length - offset)));
  } });
}
async function records(stream: ReadableStream<Uint8Array>, limits?: { compressedBytes: number; decodedBytes: number; recordBytes: number }) {
  const result: unknown[] = [];
  for await (const item of decodeCommunityArchive(stream, limits)) result.push(item);
  return result;
}

describe("portable community archive framing", () => {
  it("round trips unicode and arbitrary file bytes through fragmented gzip transport", async () => {
    const expected = [{ type: "header", name: "Gemeinschaft 🌍" }, { type: "chunk", data: Buffer.from([0, 255, 13, 10]).toString("base64") }, { type: "end" }];
    async function* source() { yield* expected; }
    const data = new Uint8Array(await new Response(encodeCommunityArchive(source())).arrayBuffer());
    expect(await records(body(data, 1))).toEqual(expected);
  });
  it("propagates producer failure and bounds compressed output", async () => {
    async function* failed() { yield { type: "header" }; throw new Error("Producer failed"); }
    await expect(new Response(encodeCommunityArchive(failed())).arrayBuffer()).rejects.toThrow();
    async function* source() { yield { data: "hello" }; }
    await expect(new Response(encodeCommunityArchive(source(), { compressedBytes: 1, decodedBytes: 100, recordBytes: 100 })).arrayBuffer()).rejects.toThrow();
  });
  it("applies backpressure and closes the producer on downstream cancellation", async () => {
    let produced = 0;
    let finished!: () => void;
    const closed = new Promise<void>((resolve) => { finished = resolve; });
    async function* source() {
      try {
        for (; produced < 1000; produced++) yield { data: randomBytes(16 * 1024).toString("base64") };
      } finally { finished(); }
    }
    const reader = encodeCommunityArchive(source()).getReader();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(produced).toBeLessThan(1000);
    await reader.read();
    await reader.cancel();
    await closed;
    expect(produced).toBeLessThan(1000);
  });
  it("cancels a stalled upstream when decoding stops early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(gzipSync('{"type":"one"}\n{"type":"two"}\n')); },
      cancel() { cancelled = true; },
    });
    const iterator = decodeCommunityArchive(stream);
    expect((await iterator.next()).value).toEqual({ type: "one" });
    await iterator.return(undefined);
    expect(cancelled).toBe(true);
  });
  it("rejects truncated or corrupt gzip instead of accepting a valid prefix", async () => {
    const data = gzipSync('{"type":"end"}\n');
    await expect(records(body(data.subarray(0, data.length - 4)))).rejects.toThrow();
    const corrupt = Buffer.from(data); corrupt[corrupt.length - 8] ^= 1;
    await expect(records(body(corrupt))).rejects.toThrow();
  });
  it("enforces real compressed, inflated and per-record byte limits", async () => {
    const text = `${JSON.stringify({ data: "x".repeat(3000) })}\n`;
    const compressed = gzipSync(text);
    await expect(records(body(compressed), { compressedBytes: 1, decodedBytes: 5000, recordBytes: 5000 })).rejects.toThrow();
    await expect(records(body(compressed, 2), { compressedBytes: 5000, decodedBytes: 100, recordBytes: 5000 })).rejects.toThrow();
    await expect(records(body(compressed, 2), { compressedBytes: 5000, decodedBytes: 5000, recordBytes: 100 })).rejects.toThrow();
  });
  it("aborts a stalled upload and cancels its reader", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const controller = new AbortController();
    const iterator = decodeCommunityArchive(stalled, undefined, controller.signal);
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it("rejects invalid UTF-8, JSON and unterminated records", async () => {
    for (const raw of [Buffer.from([0xff, 10]), Buffer.from('not-json\n'), Buffer.from('{"type":"end"}')]) {
      await expect(records(body(gzipSync(raw)))).rejects.toThrow();
    }
  });
});
