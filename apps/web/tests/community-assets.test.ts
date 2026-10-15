import { describe, expect, it } from "vitest";
import { assetText, assetToken, assetTokens, decodeAssetTokens, encodeAssetShortcodes, remapAssetTokens } from "@/lib/community-assets";

const asset = { id: "019a1234-1234-7123-8123-123456789abc", name: "party_blob", kind: "emoji" as const };
const token = assetToken(asset);

describe("private community content tokens", () => {
  it("preserves Unicode and provides readable deleted-media projections", () => {
    expect(assetText(`🎉 ${token}`)).toBe("🎉 :party_blob:");
    expect(assetText(assetToken({ ...asset, kind: "sticker" }))).toBe("[sticker: party_blob]");
    expect(assetTokens(token)).toEqual([asset]);
  });
  it("ignores inline code, fenced code and URL segments", () => {
    const code = `\`${token}\`\n\`\`\`ts\n${token}\n\`\`\``;
    expect(assetTokens(code)).toEqual([]);
    expect(assetText(code)).toBe(code);
    expect(encodeAssetShortcodes("https://example.com/:party_blob: `:party_blob:`", [asset])).toBe("https://example.com/:party_blob: `:party_blob:`");
  });
  it("only remaps declarations to matching fresh immutable references", () => {
    const target = { ...asset, id: "019a1234-1234-7123-8123-123456789abd" };
    expect(remapAssetTokens(token, new Map([[asset.id, target]]))).toBe(assetToken(target));
    expect(remapAssetTokens(token, new Map([[asset.id, { ...target, name: "other" }]]))).toBe(":party_blob:");
    expect(encodeAssetShortcodes(decodeAssetTokens(token), [asset])).toBe(token);
  });
});
