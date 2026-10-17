"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";

export type GifProviderKeys = { klipy: string | null; giphy: string | null };

const GifPickerContent = dynamic(() => import("./gif-picker-content"), {
  ssr: false,
  loading: () => <p role="status" className="p-4 text-muted-foreground">Loading GIFs…</p>,
});

// Shared across composers; never contacts a third-party service until a picker is opened.
let configRequest: Promise<GifProviderKeys> | null = null;
function getConfig(): Promise<GifProviderKeys> {
  if (!configRequest) {
    configRequest = fetch("/api/gifs/providers", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load GIF providers.");
        return (await response.json()) as GifProviderKeys;
      })
      .catch((error: unknown) => {
        configRequest = null;
        throw error;
      });
  }
  return configRequest;
}

export function GifSelector({ onPick, returnFocusTo, disabled = false }: {
  onPick: (url: string) => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  disabled?: boolean;
}) {
  const [config, setConfig] = useState<GifProviderKeys | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void getConfig().then(
      (value) => { if (active) setConfig(value); },
      () => {}, // The button is hidden when providers are unavailable.
    );
    return () => { active = false; };
  }, []);

  if (!config?.klipy && !config?.giphy) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={
        <Button type="button" variant="ghost" size="icon" className="mb-1 shrink-0" aria-label="Choose GIF" disabled={disabled}>
          <span aria-hidden className="text-[11px] font-bold tracking-tight">GIF</span>
        </Button>
      } />
      <PopoverContent side="top" align="start" className="w-[370px] max-w-[calc(100vw-1rem)] gap-2 p-2" finalFocus={returnFocusTo}>
        <PopoverTitle className="sr-only">Choose GIF</PopoverTitle>
        {open && <GifPickerContent keys={config} onPick={(url) => { onPick(url); setOpen(false); }} />}
      </PopoverContent>
    </Popover>
  );
}
