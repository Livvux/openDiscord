/** Initial on a translucent disc, as in the landing-page preview. No uploaded images, so no third-party requests. */
export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
  const sizes = { sm: "size-7 text-[11px]", md: "size-8 text-xs", lg: "size-20 text-3xl" };
  return (
    <span
      aria-hidden
      className={`${sizes[size]} grid shrink-0 place-items-center rounded-full bg-white/10 font-medium text-zinc-100 select-none`}
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
