"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function RailLink({ href, name }: { href: string; name: string }) {
  const active = usePathname().startsWith(href);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase())
    .join("");
  return (
    <Link
      href={href}
      title={name}
      aria-label={name}
      aria-current={active ? "page" : undefined}
      className={`relative grid size-10 place-items-center text-sm font-semibold transition-[border-radius,background-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        active ? "rounded-xl bg-primary text-primary-foreground" : "rounded-2xl bg-white/5 text-zinc-300 hover:rounded-xl hover:bg-white/10"
      }`}
    >
      {initials}
    </Link>
  );
}
