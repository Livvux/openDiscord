import { describe, expect, it } from "vitest";
import { gifSource } from "@/lib/gifs";

describe("external GIF URL allowlist", () => {
  it.each([
    ["https://media.giphy.com/media/abc/giphy.gif", "giphy"],
    ["https://media4.giphy.com/media/abc/giphy.gif?cid=123", "giphy"],
    ["https://i.giphy.com/abc.webp", "giphy"],
    ["https://static.klipy.com/ii/hash/path/image.gif", "klipy"],
    ["https://static1.klipy.com/ii/hash/path/image.gif", "klipy"],
    ["https://static2.klipy.com/ii/hash/path/image.gif", "klipy"],
  ] as const)("accepts provider media: %s", (url, provider) => {
    expect(gifSource(url)).toBe(provider);
  });

  it.each([
    "http://media.giphy.com/media/abc/giphy.gif",
    "https://media.giphy.com.evil.example/giphy.gif",
    "https://notgiphy.com/cat.gif",
    "https://evil.example/cat.gif",
    "https://static.klipy.com.evil.example/cat.gif",
    "https://static.klipy.com:444/cat.gif",
    "https://user:pass@static.klipy.com/cat.gif",
    "https://static.klipy.com/cat.svg",
    "https://static.klipy.com/cat.gif#fragment",
    "https://static.klipy.com/cat.gif\nanother line",
    "javascript:alert(1)",
    "https://api.giphy.com/v1/gifs/trending",
    "",
  ])("rejects URLs that are not trusted GIF assets: %s", (url) => {
    expect(gifSource(url)).toBeNull();
  });
});
