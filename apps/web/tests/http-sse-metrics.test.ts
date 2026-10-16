import { describe, expect, it } from "vitest";
import { SseFrames, summarize } from "../scripts/http-sse-metrics";

describe("HTTP/SSE characterization measurements", () => {
  it("retains partial frames and ignores retry directives", () => {
    const frames = new SseFrames();
    expect(frames.push('retry: 2000\n\nevent: message.cre')).toEqual([]);
    expect(frames.push('ated\ndata: {"id":"1"}\n\nevent: ready\ndata: {}\n\n')).toEqual([
      { event: "message.created", data: '{"id":"1"}' }, { event: "ready", data: "{}" },
    ]);
  });
  it("bounds incomplete frames", () => {
    expect(() => new SseFrames().push("x".repeat(1_048_577))).toThrow(/bound/);
  });
  it("bounds complete frames before parsing a single chunk", () => {
    expect(() => new SseFrames().push(`data: ${"x".repeat(1_048_577)}\n\n`)).toThrow(/bound/);
  });
  it("bounds oversized frames completed by a later delimiter chunk", () => {
    const frames = new SseFrames();
    expect(frames.push("x".repeat(1_048_576))).toEqual([]);
    expect(() => frames.push("x\n\n")).toThrow(/bound/);
  });
  it("accepts a chunk larger than the limit when each frame is within it", () => {
    const data = "x".repeat(600_000);
    expect(new SseFrames().push(`data: ${data}\n\ndata: ${data}\n\n`)).toEqual([
      { event: "message", data }, { event: "message", data },
    ]);
  });
  it("calculates nearest-rank percentiles without mutating samples", () => {
    const samples = [4, 1, 3, 2];
    expect(summarize(samples)).toEqual({ count: 4, p50: 2, p95: 4, p99: 4, max: 4 });
    expect(samples).toEqual([4, 1, 3, 2]);
    expect(() => summarize([])).toThrow(/observations/);
  });
});
