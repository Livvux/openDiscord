"use client";

import { LockIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useChannelUnread } from "./unread-provider";

interface ChannelLinkProps {
  channelId: string;
  href: string;
  name: string;
  isPrivate?: boolean;
}

export function ChannelLink({ channelId, href, name, isPrivate = false }: ChannelLinkProps) {
  const active = usePathname() === href;
  const { unread, mentions } = useChannelUnread(channelId);
  const highlight = !active && (unread || mentions > 0);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring ${
        active ? "bg-white/10 text-white" : highlight ? "font-medium text-zinc-100 hover:bg-white/5" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
      }`}
    >
      {isPrivate ? <LockIcon aria-hidden className="size-3.5 text-zinc-500" /> : <span aria-hidden className="text-zinc-500">#</span>}
      <span className="truncate">{name}</span>
      {isPrivate && <span className="sr-only">(private)</span>}
      {mentions > 0 && !active ? (
        <span className="ml-auto rounded-full bg-red-600 px-1.5 text-[10px] leading-4 font-bold text-white">
          {mentions > 99 ? "99+" : mentions}
          <span className="sr-only"> {mentions === 1 ? "mention" : "mentions"}</span>
        </span>
      ) : (
        highlight && <span className="sr-only">(unread)</span>
      )}
    </Link>
  );
}
