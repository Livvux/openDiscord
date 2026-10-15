"use client";

import { HashIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function ChannelLink({ href, name }: { href: string; name: string }) {
  const active = usePathname() === href;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-ring ${
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      <HashIcon aria-hidden className="size-4 shrink-0 opacity-60" />
      <span className="truncate">{name}</span>
    </Link>
  );
}
