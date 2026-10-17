import { describe, expect, it } from "vitest";
import { inviteCodeFrom } from "@/components/app/home/getting-started";

describe("invite code input", () => {
  it("accepts full links and bare codes, and rejects anything that could change the path", () => {
    expect(inviteCodeFrom("https://opendiscord.app/invite/BZh4s_nXf59AFP8S")).toBe("BZh4s_nXf59AFP8S");
    expect(inviteCodeFrom("  https://x.test/invite/abc-123?ref=1 ")).toBe("abc-123");
    expect(inviteCodeFrom("abc123")).toBe("abc123");
    for (const bad of ["", "../app/admin", "https://x.test/invite/", "a b", "%2e%2e", "x".repeat(65)]) expect(inviteCodeFrom(bad)).toBeNull();
  });
});
