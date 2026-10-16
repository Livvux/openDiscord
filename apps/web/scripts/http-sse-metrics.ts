/** Incremental SSE framing: chunks may split UTF-8 characters and event boundaries. */
export class SseFrames {
  private buffer = "";
  push(chunk: string): Array<{ event: string; data: string }> {
    this.buffer += chunk;
    const frames: Array<{ event: string; data: string }> = [];
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
      if (boundary > 1_048_576) throw new Error("SSE frame exceeds harness bound");
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      if (data.length) frames.push({ event, data: data.join("\n") });
    }
    if (this.buffer.length > 1_048_576) throw new Error("SSE frame exceeds harness bound");
    return frames;
  }
}

export function summarize(values: number[]) {
  if (!values.length) throw new Error("No observations");
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => Math.round(sorted[Math.ceil(p * sorted.length) - 1] * 100) / 100;
  return { count: values.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: percentile(1) };
}
