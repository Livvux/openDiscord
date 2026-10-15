"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function ChannelLink({ href, name }: { href: string; name: string }) {
  const active = usePathname() === href;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring ${
        active ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
      }`}
    >
      <span aria-hidden className="text-zinc-500">#</span>
      <span className="truncate">{name}</span>
    </Link>
  );
}
