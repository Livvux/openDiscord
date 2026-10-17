"use client";

import Image from "next/image";
import { useState } from "react";

const SIZES = { sm: { className: "size-7 text-[11px]", px: 28 }, md: { className: "size-8 text-xs", px: 32 }, lg: { className: "size-20 text-3xl", px: 80 } };

/** The profile picture (served only through the access-checked route), else the initial on a translucent disc. */
export function Avatar({ name, avatar = null, size = "md" }: { name: string; avatar?: string | null; size?: "sm" | "md" | "lg" }) {
  // Remembers which picture failed, so a newer one is tried again.
  const [failed, setFailed] = useState<string | null>(null);
  const { className, px } = SIZES[size];
  if (avatar && failed !== avatar) {
    return (
      <Image src={`/api/avatars/${avatar}`} alt="" aria-hidden width={px} height={px} unoptimized draggable={false}
        onError={() => setFailed(avatar)} className={`${className} shrink-0 rounded-full bg-white/10 object-cover select-none`} />
    );
  }
  const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden
      className={`${className} grid shrink-0 place-items-center rounded-full bg-white/10 font-medium text-zinc-100 select-none`}
    >
      {initial}
    </span>
  );
}

// Light tints from the preview (amber/sky/emerald …); all ≥ 7:1 on charcoal.
const NAME_COLORS = ["text-amber-300", "text-sky-300", "text-emerald-300", "text-rose-300", "text-violet-300", "text-cyan-300"];

/** Stable per-person name colour so speakers are easy to tell apart. */
export function nameColor(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return NAME_COLORS[hash % NAME_COLORS.length];
}
