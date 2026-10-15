"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AssetView } from "@/lib/community-assets";
import { CommunityAssetImage } from "./community-asset-image";
import { useRealtime } from "./realtime-provider";

export function CommunityAssetPicker({ channelId, emojiOnly = false, onPick }: { channelId: string; emojiOnly?: boolean; onPick: (asset: AssetView) => void }) {
  const [assets, setAssets] = useState<AssetView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { subscribe } = useRealtime();
  useEffect(() => {
    const controller = new AbortController();
    let generation = 0;
    async function load() {
      const requestGeneration = ++generation;
      try {
        const response = await fetch(`/api/channels/${channelId}/assets`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Community images could not be loaded.");
        const assets = await response.json() as AssetView[];
        if (requestGeneration !== generation) return;
        setAssets(assets);
        setError(null);
      } catch (error) { if (!controller.signal.aborted && requestGeneration === generation) { setAssets([]); setError(error instanceof Error ? error.message : "Community images could not be loaded."); } }
    }
    void load();
    const unsubscribe = subscribe((event) => { if (event.type === "assets.changed" || event.type === "resync") void load(); });
    return () => { controller.abort(); unsubscribe(); };
  }, [channelId, subscribe]);
  const visible = assets.filter((asset) => !emojiOnly || asset.kind === "emoji");
  return <div className="max-h-60 max-w-full overflow-y-auto rounded-md border bg-popover p-2" aria-label="Community images">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!error && visible.length === 0 && <p className="text-sm text-muted-foreground">No community images yet.</p>}
    <div className="flex flex-wrap gap-2">{visible.map((asset) => <Button key={asset.id} type="button" variant="ghost" className="h-auto max-w-28 flex-col gap-1 p-2" aria-label={`Choose ${asset.kind} ${asset.name}`} onClick={() => onPick(asset)}>
      <CommunityAssetImage asset={{ ...asset, kind: "emoji" }} /><span className="max-w-full truncate text-xs">{asset.name}</span>
    </Button>)}</div>
  </div>;
}
