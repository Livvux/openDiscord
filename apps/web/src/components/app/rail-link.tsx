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
      className={`relative flex size-12 items-center justify-center rounded-2xl text-sm font-semibold transition-[border-radius,background-color] focus-visible:outline-2 focus-visible:outline-ring ${
        active ? "rounded-xl bg-primary text-primary-foreground" : "bg-card text-foreground hover:rounded-xl hover:bg-primary/70"
      }`}
    >
      {active && <span aria-hidden className="absolute -left-2 h-8 w-1 rounded-r bg-foreground" />}
      {initials}
    </Link>
  );
}
