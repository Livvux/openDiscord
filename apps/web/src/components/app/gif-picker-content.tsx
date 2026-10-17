"use client";

import { useMemo, useState } from "react";
import { GifPicker, Theme } from "gif-picker-react";
import { Klipy, ContentFilter } from "gif-picker-react/providers/klipy";
import { Giphy, ContentRating } from "gif-picker-react/providers/giphy";
import { gifSource } from "@/lib/gifs";
import type { GifProviderKeys } from "./gif-selector";

type Provider = "klipy" | "giphy";

export default function GifPickerContent({ keys, onPick }: { keys: GifProviderKeys; onPick: (url: string) => void }) {
  const [selected, setSelected] = useState<Provider>(keys.klipy ? "klipy" : "giphy");
  const [error, setError] = useState<string | null>(null);
  const provider = useMemo(
    () => selected === "klipy"
      ? Klipy(keys.klipy!, { contentFilter: ContentFilter.HIGH, showBranding: true })
      : Giphy(keys.giphy!, { rating: ContentRating.PG }),
    [keys, selected],
  );

  return (
    <>
      {keys.klipy && keys.giphy && (
        <div className="flex gap-1" role="group" aria-label="GIF provider">
          {(["klipy", "giphy"] as const).map((name) => (
            <button key={name} type="button" aria-pressed={selected === name}
              onClick={() => { setSelected(name); setError(null); }}
              className={selected === name
                ? "rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-foreground"
                : "rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"}>
              {name === "klipy" ? "KLIPY" : "GIPHY"}
            </button>
          ))}
        </div>
      )}
      <div className="min-w-0 overflow-hidden rounded-md [&_.GifPickerReact]:max-w-full">
        <GifPicker key={selected} provider={provider} theme={Theme.DARK} width="100%" height={350}
          onGifClick={(gif) => {
            if (gifSource(gif.imageUrl) !== selected) {
              setError("Unsupported GIF URL returned by the provider.");
              return;
            }
            onPick(gif.imageUrl);
          }}
        />
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <p className="px-1 text-[11px] text-muted-foreground">
        Searching contacts {selected === "klipy" ? "KLIPY" : "GIPHY"}. Sending shares a GIF link, not a file.
      </p>
    </>
  );
}
