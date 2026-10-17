"use client";

import type { EmojiClickData } from "emoji-picker-react/primitives";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { assetToken, type AssetView } from "@/lib/community-assets";
import { twemojiUrl } from "@/lib/emoji";
import { useCommunityAssets } from "./use-community-assets";

type Props = { channelId?: string; stickers?: boolean; reactions?: boolean; onPick: (emoji: string, asset?: AssetView) => void };

function Picker({ assets = [], error, stickers, reactions, onPick }: Props & { assets?: AssetView[]; error?: string | null }) {
  const custom = assets.filter((asset) => stickers || asset.kind === "emoji");
  function pick(data: EmojiClickData) {
    if (!data.isCustom) return onPick(data.emoji);
    const asset = custom.find((asset) => asset.id === data.unified);
    if (asset) onPick(assetToken(asset), asset);
  }
  return <>
    {error && <p role="alert" className="px-2 text-sm text-destructive">{error}</p>}
    <EmojiPicker
      emojiStyle="twitter"
      emojiVersion="17.0"
      getEmojiUrl={twemojiUrl}
      customEmojis={custom.map((asset) => ({ id: asset.id, names: [asset.name], imgUrl: `/api/community-assets/${asset.id}`, group: asset.kind === "sticker" ? "Stickers" : "Community" }))}
      reactionsDefaultOpen={reactions}
      reactions={["👍", "❤️", "😂", "🎉", "😮", "😢", "👀", "✅"]}
      onEmojiClick={pick}
      onReactionClick={pick}
      className="h-[min(368px,60dvh)] [&:has([data-epr-part=reactions])]:h-auto"
    />
    <a href="/twemoji/17.0.3/ATTRIBUTION.md" target="_blank" rel="noopener noreferrer" className="px-2 text-[10px] text-muted-foreground underline">Twemoji · CC BY 4.0</a>
  </>;
}

function CommunityPicker(props: Props & { channelId: string }) {
  const { assets, error } = useCommunityAssets(props.channelId);
  return <Picker {...props} assets={assets} error={error} />;
}

export default function EmojiPickerContent(props: Props) {
  return props.channelId ? <CommunityPicker {...props} channelId={props.channelId} /> : <Picker {...props} />;
}
