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
  it("calculates nearest-rank percentiles without mutating samples", () => {
    const samples = [4, 1, 3, 2];
    expect(summarize(samples)).toEqual({ count: 4, p50: 2, p95: 4, p99: 4, max: 4 });
    expect(samples).toEqual([4, 1, 3, 2]);
    expect(() => summarize([])).toThrow(/observations/);
  });
});
