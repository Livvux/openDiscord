"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { communityInitials } from "./community-icon";
import { useCommunityUnread, useReportCommunityUnread, type UnreadSummary } from "./notifications-provider";

interface RailLinkProps {
  communityId: string;
  name: string;
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

export const railTile = (active: boolean) =>
  `relative grid size-12 place-items-center rounded-2xl transition-[background-color,color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
    active ? "bg-primary text-primary-foreground" : "bg-white/[0.08] hover:bg-primary hover:text-primary-foreground"
  }`;

export function RailLink({ communityId, name, initial, muted }: RailLinkProps) {
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
      <Link
        href={href}
        title={name}
        aria-label={`${name}${status}, ${initials}`}
        aria-current={active ? "page" : undefined}
        className={`${railTile(active)} text-base font-medium ${active ? "" : muted ? "text-muted-foreground" : "text-sidebar-foreground"}`}
      >
        {initials}
        <RailBadge count={mentions} />
      </Link>
    </div>
  );
}
