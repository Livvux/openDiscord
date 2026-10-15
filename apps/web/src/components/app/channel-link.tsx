"use client";

import { LockIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function ChannelLink({ href, name, isPrivate = false }: { href: string; name: string; isPrivate?: boolean }) {
  const active = usePathname() === href;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring ${
        active ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
      }`}
    >
      {isPrivate ? <LockIcon aria-hidden className="size-3.5 text-zinc-500" /> : <span aria-hidden className="text-zinc-500">#</span>}
      <span className="truncate">{name}</span>
      {isPrivate && <span className="sr-only">(private)</span>}
    </Link>
  );
}
