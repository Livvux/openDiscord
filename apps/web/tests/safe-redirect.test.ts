import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/safe-redirect";

describe("safeNextPath", () => {
  it("keeps same-origin paths with query and hash", () => {
    expect(safeNextPath("/invite/abc123?x=1#y")).toBe("/invite/abc123?x=1#y");
  });

  it.each([
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "evil",
    "",
  ])("rejects %j", (value) => {
    expect(safeNextPath(value)).toBe("/app");
  });

  it("falls back when missing", () => {
    expect(safeNextPath(null)).toBe("/app");
  });
});
