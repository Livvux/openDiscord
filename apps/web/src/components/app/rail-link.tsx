"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useCommunityUnread, useReportCommunityUnread, type UnreadSummary } from "./notifications-provider";

interface RailLinkProps {
  communityId: string;
  name: string;
  /** Server-rendered unread state; live updates come from the notifications provider. */
  initial: UnreadSummary;
}

export function RailLink({ communityId, name, initial }: RailLinkProps) {
  const href = `/app/c/${communityId}`;
  const active = usePathname().startsWith(href);
  const report = useReportCommunityUnread();
  // Every server render (navigation, refresh) brings a new `initial` object and is authoritative again.
  useEffect(() => report?.(communityId, initial), [report, communityId, initial]);
  const { unread, mentions } = useCommunityUnread(communityId, initial);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase())
    .join("");
  const status = mentions > 0 ? `, ${mentions} ${mentions === 1 ? "mention" : "mentions"}` : unread ? ", unread messages" : "";
  return (
    <Link
      href={href}
      title={name}
      aria-label={`${name}${status}`}
      aria-current={active ? "page" : undefined}
      className={`relative grid size-10 place-items-center text-sm font-semibold transition-[border-radius,background-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        active ? "rounded-xl bg-primary text-primary-foreground" : "rounded-2xl bg-white/5 text-zinc-300 hover:rounded-xl hover:bg-white/10"
      }`}
    >
      {initials}
      {unread && !active && <span aria-hidden className="absolute top-1/2 -left-3 h-2 w-1 -translate-y-1/2 rounded-r-full bg-zinc-100" />}
      {mentions > 0 && (
        <span aria-hidden className="absolute -right-1 -bottom-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] leading-4 font-bold text-white ring-2 ring-sidebar">
          {mentions > 99 ? "99+" : mentions}
        </span>
      )}
    </Link>
  );
}
