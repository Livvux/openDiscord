import Link from "next/link";
import { communityInitials } from "@/components/app/community-icon";
import type { DiscoverableCommunity } from "@/server/discovery";

/** Communities have no banner upload yet: a stable hue per id keeps cards apart. */
export function bannerHue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function bannerStyle(id: string): React.CSSProperties {
  const hue = bannerHue(id);
  return { background: `linear-gradient(135deg, oklch(0.55 0.15 ${hue}), oklch(0.4 0.12 ${(hue + 40) % 360}))` };
}

export function MemberCounts({ online, members }: { online: number; members: number }) {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-[#23a55a]" />{online.toLocaleString("en")} Online</span>
      <span className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-muted-foreground" />{members.toLocaleString("en")} {members === 1 ? "Member" : "Members"}</span>
    </p>
  );
}

export function CommunityCard({ community: c }: { community: DiscoverableCommunity }) {
  return (
    <li>
      <Link
        href={`/app/discover/${c.id}`}
        className="group flex h-full flex-col overflow-hidden rounded-lg bg-card ring-1 ring-white/5 transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-xl hover:ring-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      >
        <div aria-hidden className="h-28 shrink-0" style={bannerStyle(c.id)} />
        <div className="relative flex flex-1 flex-col gap-2 px-4 pt-9 pb-4">
          <span aria-hidden className="absolute -top-7 left-3 grid size-14 place-items-center rounded-2xl bg-sidebar text-lg font-semibold text-sidebar-foreground ring-4 ring-card">
            {communityInitials(c.name)}
          </span>
          <h3 className="truncate text-base font-semibold">{c.name}</h3>
          <p className="line-clamp-3 flex-1 text-sm break-words text-muted-foreground">{c.description}</p>
          <MemberCounts online={c.onlineCount} members={c.memberCount} />
        </div>
      </Link>
    </li>
  );
}
