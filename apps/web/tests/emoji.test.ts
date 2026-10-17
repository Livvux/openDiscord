import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import data from "emoji-picker-react/data/emojis-en";
import { emojiUnified, insertEmoji, isUnicodeEmoji, twemojiUrl } from "@/lib/emoji";
import assets from "@/lib/twemoji-assets.json";

describe("local Twemoji", () => {
  it("keeps the manifest in sync with the distributed graphics", () => {
    expect(readdirSync("public/twemoji/17.0.3/svg").map((name) => name.replace(/\.svg$/, "")).sort()).toEqual(assets);
  });

  it("normalizes picker IDs with leading zeros and variation selectors", () => {
    expect(twemojiUrl("0023-fe0f-20e3")).toBe("/twemoji/17.0.3/svg/23-20e3.svg");
    expect(twemojiUrl("00A9-fe0f")).toBe("/twemoji/17.0.3/svg/a9.svg");
  });

  it.each(["😀", "❤️", "👍🏽", "🇩🇪", "1️⃣", "🏳️‍🌈", "👩🏽‍❤️‍💋‍👨🏻", "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"])("supports a complete sequence: %s", (emoji) => {
    expect(isUnicodeEmoji(emoji)).toBe(true);
    expect(twemojiUrl(emojiUnified(emoji))).toMatch(/^\/twemoji\/17\.0\.3\/svg\/[a-f0-9-]+\.svg$/);
  });

  it.each(["lol", "<b>", "1", "👍x", "", "😀0000", "👍👍", "🇩", "../secret"])("rejects non-emoji reactions: %s", (text) => {
    expect(isUnicodeEmoji(text)).toBe(false);
  });

  it("ships every graphic requested by the picker, including skin-tone variants", () => {
    const missing = [];
    for (const list of Object.values(data.emojis)) for (const emoji of list) {
      for (const id of [emoji.u, ...(emoji.v ?? [])]) {
        const file = twemojiUrl(id).split("/").at(-1)!.slice(0, -4);
        if (!assets.includes(file)) missing.push(id);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("composer insertion", () => {
  it("inserts at the caret and replaces a selection", () => {
    expect(insertEmoji("hello world", "👍🏽", 6, 11, 100)).toEqual({ value: "hello 👍🏽", caret: 10 });
    expect(insertEmoji("ab", "😀", 1, 1, 4)).toEqual({ value: "a😀b", caret: 3 });
  });
  it("respects UTF-16 message limits without truncating a sequence", () => {
    expect(insertEmoji("ab", "😀", 1, 1, 3)).toBeNull();
    expect(insertEmoji("ab", "😀", 0, 2, 2)).toEqual({ value: "😀", caret: 2 });
  });
});
