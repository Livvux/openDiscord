/** Up to two initials, as Discord shows servers without an icon. */
export function communityInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase())
    .join("");
}

/** A small server badge for headers and the title bar (the rail draws its own 48px tile). */
export function CommunityIcon({ name, size = "xs" }: { name: string; size?: "xs" | "sm" }) {
  return (
    <span aria-hidden className={`grid shrink-0 place-items-center bg-white/10 font-semibold text-sidebar-foreground ${size === "xs" ? "size-4 rounded-[5px] text-[8px]" : "size-6 rounded-md text-[10px]"}`}>
      {communityInitials(name)}
    </span>
  );
}
