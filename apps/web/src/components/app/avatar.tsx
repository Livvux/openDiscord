/** Initials on a colour derived from the name. No uploaded images yet, so no third-party requests. */
export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? "")
    .join("");
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  const sizes = { sm: "size-8 text-xs", md: "size-10 text-sm", lg: "size-12 text-base" };
  return (
    <span
      aria-hidden
      className={`${sizes[size]} inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none`}
      style={{ backgroundColor: `oklch(0.55 0.13 ${hash})` }}
    >
      {initials || "?"}
    </span>
  );
}
