"use client";

import { useEffect, useState } from "react";
import type { AssetView } from "@/lib/community-assets";
import { useRealtime } from "./realtime-provider";

export function useCommunityAssets(channelId: string) {
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
  return { assets, error };
}
