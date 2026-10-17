"use client";

import dynamic from "next/dynamic";
import { useState, type ReactElement, type RefObject } from "react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { AssetView } from "@/lib/community-assets";

const EmojiPickerContent = dynamic(() => import("./emoji-picker-content"), {
  ssr: false,
  loading: () => <p role="status" className="p-4 text-muted-foreground">Loading emojis…</p>,
});

export function EmojiSelector({ trigger, channelId, stickers, reactions, onPick, returnFocusTo }: {
  trigger: ReactElement;
  channelId?: string;
  stickers?: boolean;
  reactions?: boolean;
  onPick: (emoji: string, asset?: AssetView) => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={trigger} />
    <PopoverContent side="top" align="start" className="w-[344px] max-w-[calc(100vw-1rem)] gap-1 p-2" finalFocus={returnFocusTo}>
      <PopoverTitle className="sr-only">{reactions ? "Add a reaction" : "Choose emoji or sticker"}</PopoverTitle>
      {open && <EmojiPickerContent channelId={channelId} stickers={stickers} reactions={reactions} onPick={(emoji, asset) => { onPick(emoji, asset); setOpen(false); }} />}
    </PopoverContent>
  </Popover>;
}
