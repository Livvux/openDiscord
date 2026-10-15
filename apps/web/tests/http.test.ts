import { describe, expect, it } from "vitest";
import { readJsonBody } from "@/server/http";

const req = (body: string, length?: number) =>
  new Request("http://x/", { method: "POST", body, headers: length === undefined ? {} : { "content-length": String(length) } });

describe("readJsonBody", () => {
  it("parses small JSON bodies", async () => {
    expect(await readJsonBody(req('{"a":1}'), 100)).toEqual({ a: 1 });
  });

  it("refuses oversized bodies by announced length or by actual size, in bytes", async () => {
    await expect(readJsonBody(req("{}", 10_000), 100)).rejects.toThrow("too large");
    await expect(readJsonBody(req(JSON.stringify({ s: "ü".repeat(60) })), 100)).rejects.toThrow("too large");
  });

  it("refuses invalid JSON", async () => {
    await expect(readJsonBody(req("nope"), 100)).rejects.toThrow("JSON");
  });
});

describe("uuidv7", () => {
  it("encodes the time, sorts by it and stays unique within a millisecond", async () => {
    const { uuidv7 } = await import("@/server/uuidv7");
    const t = Date.parse("2024-01-02T03:04:05.006Z");
    const a = uuidv7(t);
    const b = uuidv7(t);
    const later = uuidv7(t + 1);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(a.replace(/-/g, "").slice(0, 12), 16)).toBe(t);
    expect(a < b && b < later).toBe(true);
  });
});
