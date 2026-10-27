"use client";

import { HashIcon, LockIcon, Volume2Icon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useChannelUnread } from "./unread-provider";

interface ChannelLinkProps {
  channelId: string;
  href: string;
  name: string;
  isPrivate?: boolean;
  kind?: "text" | "voice";
}

export function ChannelLink({ channelId, href, name, isPrivate = false, kind = "text" }: ChannelLinkProps) {
  const active = usePathname() === href;
  const { unread, mentions } = useChannelUnread(channelId);
  const highlight = !active && (unread || mentions > 0);
  const Icon = kind === "voice" ? Volume2Icon : isPrivate ? LockIcon : HashIcon;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-8 items-center gap-1.5 rounded-lg px-2 text-base focus-visible:outline-2 focus-visible:outline-ring ${
        active ? "bg-white/10 font-medium text-sidebar-foreground" : highlight ? "font-semibold text-sidebar-foreground hover:bg-white/[0.06]" : "font-medium text-muted-foreground hover:bg-white/[0.06] hover:text-sidebar-foreground"
      }`}
    >
      {/* Discord's unread pill on the column's edge. */}
      {highlight && <span aria-hidden className="absolute top-1/2 -left-2 h-2 w-1 -translate-y-1/2 rounded-r-full bg-sidebar-foreground" />}
      <Icon aria-hidden className="size-5 shrink-0 opacity-70" />
      <span className="truncate">{name}</span>
      {kind === "voice" && <span className="sr-only">(voice)</span>}
      {isPrivate && <span className="sr-only">(private)</span>}
      {mentions > 0 && !active ? (
        <span className="ml-auto min-w-4 rounded-full bg-[#dc2626] px-1 text-center text-xs leading-4 font-bold text-white">
          {mentions > 99 ? "99+" : mentions}
          <span className="sr-only"> {mentions === 1 ? "mention" : "mentions"}</span>
        </span>
      ) : (
        highlight && <span className="sr-only">(unread)</span>
      )}
    </Link>
  );
}
