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
