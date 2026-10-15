import { describe, expect, it } from "vitest";
import { assetShortcode, assetText, assetTokens, encodeAssetShortcodes, remapAssetTokens } from "@/lib/community-assets";

const emoji = { id: "01900000-0000-7000-8000-000000000001", name: "hello", kind: "emoji" as const };
const sticker = { id: "01900000-0000-7000-8000-000000000002", name: "wave", kind: "sticker" as const };
const token = `<emoji:${emoji.name}:${emoji.id}>`;
const stickerToken = `<sticker:${sticker.name}:${sticker.id}>`;

describe("community asset content boundaries", () => {
  it("recognizes immutable references outside code and links without interpreting HTML", () => {
    const content = `**${token}** ${stickerToken} \`${token}\`\n\`\`\`ts\n${token}\n\`\`\` https://example.test/:hello: <img src=x>`;
    expect(assetTokens(content)).toEqual([emoji, sticker]);
    expect(assetText(content)).toContain("**:hello:** [sticker: wave]");
    expect(assetText(content)).toContain(`\`${token}\``);
    expect(assetText(content)).toContain("<img src=x>");
  });

  it("encodes only selected shortcodes and preserves code, URLs and unselected names", () => {
    const content = ":hello: :sticker/wave: :unknown: `:hello:` https://example.test/:hello:";
    expect(encodeAssetShortcodes(content, [emoji, sticker])).toBe(`${token} ${stickerToken} :unknown: \`:hello:\` https://example.test/:hello:`);
    expect(assetShortcode(sticker)).toBe(":sticker/wave:");
  });

  it("remaps only declared source assets and makes missing media readable", () => {
    const replacement = { ...emoji, id: "01900000-0000-7000-8000-000000000003" };
    expect(remapAssetTokens(`${token} ${stickerToken}`, new Map([[emoji.id, replacement]])))
      .toBe(`<emoji:hello:${replacement.id}> [sticker: wave]`);
    expect(remapAssetTokens(token, new Map())).toBe(":hello:");
    expect(remapAssetTokens(token, new Map([[emoji.id, { ...replacement, kind: "sticker" }]]))).toBe(":hello:");
  });
});
