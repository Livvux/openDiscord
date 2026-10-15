import { z } from "zod";

export const assetRefSchema = z.object({
  id: z.uuid(),
  name: z.string().regex(/^[a-z0-9_]{2,32}$/),
  kind: z.enum(["emoji", "sticker"]),
});
export type AssetRef = z.infer<typeof assetRefSchema>;
export interface AssetView extends AssetRef { width: number; height: number }

export const MAX_COMMUNITY_EMOJI = 128;
export const MAX_COMMUNITY_STICKERS = 64;
export const MAX_COMMUNITY_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_MESSAGE_ASSETS = 32;
export const MAX_MESSAGE_STICKERS = 3;
export const assetRawLimit = (kind: AssetRef["kind"]) => kind === "emoji" ? 256 * 1024 : 1024 * 1024;
export const assetDimension = (kind: AssetRef["kind"]) => kind === "emoji" ? 128 : 512;

export const ASSET_TOKEN_SOURCE = String.raw`<(emoji|sticker):([a-z0-9_]{2,32}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>`;
const protectedParts = /```(?:[\w+-]{1,20}\n)?[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s<>]+/g;

function outsideCodeAndLinks(content: string, transform: (text: string) => string): string {
  let result = "";
  let end = 0;
  for (const part of content.matchAll(protectedParts)) {
    result += transform(content.slice(end, part.index)) + part[0];
    end = part.index + part[0].length;
  }
  return result + transform(content.slice(end));
}

export const assetShortcode = (asset: Pick<AssetRef, "kind" | "name">) => asset.kind === "emoji" ? `:${asset.name}:` : `:sticker/${asset.name}:`;
const fallback = (asset: Pick<AssetRef, "kind" | "name">) => asset.kind === "emoji" ? `:${asset.name}:` : `[sticker: ${asset.name}]`;
export const assetToken = (asset: AssetRef) => `<${asset.kind}:${asset.name}:${asset.id}>`;

export function assetTokens(content: string): AssetRef[] {
  const references: AssetRef[] = [];
  outsideCodeAndLinks(content, (text) => {
    for (const match of text.matchAll(new RegExp(ASSET_TOKEN_SOURCE, "g"))) {
      const parsed = assetRefSchema.safeParse({ kind: match[1], name: match[2], id: match[3] });
      if (parsed.success) references.push(parsed.data);
    }
    return text;
  });
  return references;
}

/** Archives may only enroll freshly imported assets, never an existing destination ID. */
export function remapAssetTokens(content: string, assets: ReadonlyMap<string, AssetRef>): string {
  return outsideCodeAndLinks(content, (text) => text.replace(new RegExp(ASSET_TOKEN_SOURCE, "g"), (_token, kind: string, name: string, id: string) => {
    const source = assetRefSchema.safeParse({ kind, name, id });
    if (!source.success) return _token;
    const target = assets.get(id);
    return target?.kind === kind && target.name === name ? assetToken(target) : fallback(source.data);
  }));
}

export const assetText = (content: string) => remapAssetTokens(content, new Map());

/** Only references explicitly selected in this composer/editor become stored tokens. */
export function encodeAssetShortcodes(content: string, assets: readonly AssetRef[]): string {
  const selected = new Map(assets.map((asset) => [assetShortcode(asset), asset]));
  const shortcodes = new RegExp(`${ASSET_TOKEN_SOURCE}|:sticker/[a-z0-9_]{2,32}:|:[a-z0-9_]{2,32}:`, "g");
  return outsideCodeAndLinks(content, (text) => text.replace(shortcodes, (value) => {
    const asset = selected.get(value);
    return asset ? assetToken(asset) : value;
  }));
}

export function decodeAssetTokens(content: string): string {
  return outsideCodeAndLinks(content, (text) => text.replace(new RegExp(ASSET_TOKEN_SOURCE, "g"), (_token, kind: string, name: string, id: string) => {
    const parsed = assetRefSchema.safeParse({ kind, name, id });
    return parsed.success ? assetShortcode(parsed.data) : _token;
  }));
}
