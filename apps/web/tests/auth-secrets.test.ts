import { describe, expect, it } from "vitest";
import { authSecrets } from "@/lib/auth-secrets";

describe("versioned auth secrets", () => {
  it("preserves key order and leaves legacy-only deployments unchanged", () => {
    expect(authSecrets(undefined)).toBeUndefined();
    expect(authSecrets("")).toBeUndefined();
    expect(authSecrets(`2:${"a".repeat(32)},1:${"b".repeat(32)}`)).toEqual([
      { version: 2, value: "a".repeat(32) }, { version: 1, value: "b".repeat(32) },
    ]);
  });
  it.each(["secret-value-without-version", "1:short", `1:${"a".repeat(32)},1:${"b".repeat(32)}`,
    `01:${"a".repeat(32)}`, `1x:${"a".repeat(32)}`, `-1:${"a".repeat(32)}`, `1:${"a".repeat(32)} `,
    `9007199254740992:${"a".repeat(32)}`, `1:${"a".repeat(257)}`,
    Array.from({ length: 9 }, (_, i) => `${i}:${"a".repeat(32)}`).join(",")])("rejects invalid config without echoing it", (raw) => {
    try { authSecrets(raw); throw new Error("Expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^Invalid BETTER_AUTH_SECRETS configuration/);
      expect((error as Error).message).not.toContain(raw);
    }
  });
});
