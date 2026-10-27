/** Up to two initials, as Discord shows servers without an icon. */
export function communityInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase())
    .join("");
}

export const communityImageUrl = (id: string) => `/api/community-images/${id}`;

/** The uploaded server picture filling its parent, or the initials when there is none. */
export function CommunityPicture({ name, iconId }: { name: string; iconId: string | null }) {
  // eslint-disable-next-line @next/next/no-img-element -- already re-encoded WebP behind an authenticated route
  return iconId ? <img src={communityImageUrl(iconId)} alt="" className="size-full object-cover" draggable={false} /> : <>{communityInitials(name)}</>;
}

/** A small server badge for headers and the title bar (the rail draws its own 48px tile). */
export function CommunityIcon({ name, iconId = null, size = "xs" }: { name: string; iconId?: string | null; size?: "xs" | "sm" }) {
  return (
    <span aria-hidden className={`grid shrink-0 place-items-center overflow-hidden bg-white/10 font-semibold text-sidebar-foreground ${size === "xs" ? "size-4 rounded-[5px] text-[8px]" : "size-6 rounded-md text-[10px]"}`}>
      <CommunityPicture name={name} iconId={iconId} />
    </span>
  );
}

export { VerifiedBadge } from "./verified-badge";
