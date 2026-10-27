"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useMessages } from "@/lib/i18n/client";
import { railShape, railTile } from "./rail-styles";

export { railShape, railTile };
import { communityInitials, CommunityPicture, VerifiedBadge } from "./community-icon";
import { useCommunityUnread, useReportCommunityUnread, type UnreadSummary } from "./notifications-provider";

interface RailLinkProps {
  communityId: string;
  name: string;
  iconId: string | null;
  verified: boolean;
  /** Server-rendered unread state; live updates come from the notifications provider. */
  initial: UnreadSummary;
  /** Muted: no unread dot, mention badges stay. */
  muted: boolean;
}

/** Discord's server pill: 4px tall when unread, 20px on hover, 40px for the open server. */
export function RailPill({ active, unread }: { active: boolean; unread: boolean }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute top-1/2 -left-3 w-1 -translate-y-1/2 rounded-r-full bg-sidebar-foreground transition-[height,opacity] duration-200 motion-reduce:transition-none ${
        active ? "h-10 opacity-100" : unread ? "h-2 opacity-100 group-hover/rail:h-5" : "h-2 opacity-0 group-hover/rail:h-5 group-hover/rail:opacity-100"
      }`}
    />
  );
}

/** Red mention count, cut out of the rail with a ring in its colour. */
export function RailBadge({ count, data }: { count: number; data?: string }) {
  if (count <= 0) return null;
  return (
    <span {...(data ? { [data]: "" } : {})} aria-hidden className="absolute -right-1 -bottom-1 min-w-5 rounded-full bg-[#dc2626] px-1 text-center text-xs leading-4 font-bold text-white ring-4 ring-sidebar">
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** The name bubble right of every rail tile. */
export function RailTooltip({ label, children }: { label: React.ReactNode; children: React.ReactElement }) {
  // Touch screens have no hover; the bubble would only pop up on focus when the panel opens.
  return <Tooltip label={label} side="right" delay={0} className="[@media(hover:none)]:hidden">{children}</Tooltip>;
}

export function RailLink({ communityId, name, iconId, verified, initial, muted }: RailLinkProps) {
  const href = `/app/c/${communityId}`;
  const active = usePathname().startsWith(href);
  const report = useReportCommunityUnread();
  // Every server render (navigation, refresh) brings a new `initial` object and is authoritative again.
  useEffect(() => report?.(communityId, initial), [report, communityId, initial]);
  const { unread, mentions } = useCommunityUnread(communityId, initial);
  const initials = communityInitials(name);
  const showUnread = unread && !muted;
  const status = `${mentions > 0 ? `, ${mentions} ${mentions === 1 ? "mention" : "mentions"}` : showUnread ? ", unread messages" : ""}${muted ? ", muted" : ""}`;
  return (
    <div className="group/rail relative">
      <RailPill active={active} unread={showUnread} />
      <RailTooltip label={<span className="flex items-center gap-1.5">{verified && <VerifiedBadge tooltip={false} />}{name}</span>}>
        <Link
          href={href}
          aria-label={`${name}${verified ? ", verified" : ""}${status}${iconId ? "" : `, ${initials}`}`}
          aria-current={active ? "page" : undefined}
          className={`${iconId ? railShape(active) : railTile(active)} text-base font-medium ${active ? "" : muted ? "text-muted-foreground" : "text-sidebar-foreground"}`}
        >
          {/* The picture clips to the tile while the mention badge hangs over its corner. */}
          <span className="grid size-full place-items-center overflow-hidden rounded-[inherit]"><CommunityPicture name={name} iconId={iconId} /></span>
          <RailBadge count={mentions} />
        </Link>
      </RailTooltip>
    </div>
  );
}

/** Discord's compass: green tile, filled while browsing Discover. */
export function RailDiscoverLink({ children }: { children: React.ReactNode }) {
  const active = usePathname().startsWith("/app/discover");
  const t = useMessages().rail;
  return (
    <div className="group/rail relative">
      <RailPill active={active} unread={false} />
      <RailTooltip label={t.discover}>
        <Link
          href="/app/discover"
          aria-label={t.discoverCommunities}
          aria-current={active ? "page" : undefined}
          className={`${railShape(active)} ${active ? "bg-[#23a55a] text-white" : "bg-white/[0.08] text-[#23a55a] hover:bg-[#23a55a] hover:text-white"}`}
        >
          {children}
        </Link>
      </RailTooltip>
    </div>
  );
}
