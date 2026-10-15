import { describe, expect, it } from "vitest";
import { automodViolation } from "@/server/automod";

const rules = (words: string[], blockLinks = false) => ({ words, blockLinks });

describe("automodViolation", () => {
  it("matches whole words case- and width-insensitively", () => {
    expect(automodViolation("You are a SCAM artist", rules(["scam"]))).toBe("word");
    expect(automodViolation("ｓｃａｍ", rules(["scam"]))).toBe("word");
    expect(automodViolation("scammer and scampi", rules(["scam"]))).toBeNull();
    expect(automodViolation("Straße", rules(["straße"]))).toBe("word");
  });

  it("treats rule words literally", () => {
    expect(automodViolation("a.b", rules(["a.b"]))).toBe("word");
    expect(automodViolation("axb", rules(["a.b"]))).toBeNull();
  });

  it("blocks links only when enabled", () => {
    expect(automodViolation("see https://x.test", rules([], true))).toBe("link");
    expect(automodViolation("see www.example.com", rules([], true))).toBe("link");
    expect(automodViolation("see https://x.test", rules([]))).toBeNull();
    expect(automodViolation("version 1.2.3", rules([], true))).toBeNull();
  });
});
