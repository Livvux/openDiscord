import Link from "next/link";
import { communityImageUrl, CommunityPicture, VerifiedBadge } from "@/components/app/community-icon";
import type { DiscoverableCommunity } from "@/server/discovery";
import { MemberCounts } from "./labels";

export { DiscoverTitle, MemberCounts } from "./labels";

/** Without an uploaded banner, a stable hue per id keeps cards apart. */
export function bannerHue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function bannerStyle(id: string, bannerId: string | null = null): React.CSSProperties {
  if (bannerId) return { background: `center / cover no-repeat url(${communityImageUrl(bannerId)})` };
  const hue = bannerHue(id);
  return { background: `linear-gradient(135deg, oklch(0.55 0.15 ${hue}), oklch(0.4 0.12 ${(hue + 40) % 360}))` };
}

/** The community name, led by the verified seal as on Discord. */
export function CommunityName({ name, verified, as: Tag = "h3", className }: { name: string; verified: boolean; as?: "h1" | "h3"; className: string }) {
  return (
    <Tag className={`flex min-w-0 items-center gap-1.5 ${className}`}>
      {verified && <VerifiedBadge className="size-[1.1em]" />}
      <span className={Tag === "h1" ? "min-w-0 break-words" : "truncate"}>{name}</span>
    </Tag>
  );
}

export function CommunityCard({ community: c }: { community: DiscoverableCommunity }) {
  return (
    <li>
      <Link
        href={`/app/discover/${c.id}`}
        className="group flex h-full flex-col overflow-hidden rounded-lg bg-card ring-1 ring-white/5 transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-xl hover:ring-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      >
        <div aria-hidden className="h-28 shrink-0" style={bannerStyle(c.id, c.bannerId)} />
        <div className="relative flex flex-1 flex-col gap-2 px-4 pt-9 pb-4">
          <span aria-hidden className="absolute -top-7 left-3 grid size-14 place-items-center overflow-hidden rounded-2xl bg-sidebar text-lg font-semibold text-sidebar-foreground ring-4 ring-card">
            <CommunityPicture name={c.name} iconId={c.iconId} />
          </span>
          <CommunityName name={c.name} verified={c.verified} className="text-base font-semibold" />
          <p className="line-clamp-3 flex-1 text-sm break-words text-muted-foreground">{c.description}</p>
          <MemberCounts online={c.onlineCount} members={c.memberCount} />
        </div>
      </Link>
    </li>
  );
}
