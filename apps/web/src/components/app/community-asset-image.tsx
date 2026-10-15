"use client";

import Image from "next/image";
import { useState } from "react";
import { assetText, assetToken, type AssetView } from "@/lib/community-assets";

/** Private, immutable images retain a readable fallback after deletion or failed delivery. */
export function CommunityAssetImage({ asset }: { asset: AssetView }) {
  const [failed, setFailed] = useState(false);
  const label = assetText(assetToken(asset));
  if (failed) return <span>{label}</span>;
  return <Image src={`/api/community-assets/${asset.id}`} alt={label} title={label} unoptimized
    width={asset.width} height={asset.height} onError={() => setFailed(true)}
    className={asset.kind === "emoji" ? "inline-block size-6 align-middle object-contain" : "my-1 block max-h-64 max-w-full object-contain"} />;
}
