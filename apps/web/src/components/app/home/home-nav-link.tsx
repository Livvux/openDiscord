"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { unreadTotal } from "@/lib/dm/contracts";
import { useDirectConversations } from "../notifications-provider";

const HOME_PATHS = ["/app", "/app/friends", "/app/messages"];

/** The rail's Home button: active anywhere in the personal area; badge = unread private messages. */
export function RailHomeLink({ initialUnread = 0 }: { initialUnread?: number }) {
  const active = HOME_PATHS.includes(usePathname());
  const { direct } = useDirectConversations();
  const unread = direct ? unreadTotal(direct) : initialUnread;
  return (
    <Link
      href="/app"
      aria-label={unread > 0 ? `Home, ${unread} unread private ${unread === 1 ? "message" : "messages"}` : "Home"}
      aria-current={active ? "page" : undefined}
      title="Home"
      className={`relative mt-3 grid size-10 place-items-center transition-[border-radius,background-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        active ? "rounded-xl bg-primary" : "rounded-2xl bg-white/5 hover:rounded-xl hover:bg-white/10"
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static SVG, no optimisation needed */}
      <img src="/brand/symbol-flat.svg" alt="" width={22} height={22} />
      {unread > 0 && (
        <span data-home-unread aria-hidden className="absolute -right-1.5 -bottom-1 min-w-5 rounded-full border-2 border-sidebar bg-red-600 px-1 text-center text-[11px] leading-4 font-bold text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}

interface HomeNavLinkProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  /** Count that needs attention, e.g. incoming requests. */
  badge?: number;
}

export function HomeNavLink({ href, icon, label, badge = 0 }: HomeNavLinkProps) {
  // An open conversation (?to=) highlights its own row in the DM list instead.
  const pathname = usePathname();
  const params = useSearchParams();
  const active = pathname === href && !params.has("to");
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={badge > 0 ? `${label}, ${badge} pending` : undefined}
      className={`flex items-center gap-3 rounded-md px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-ring ${
        active ? "bg-white/10 text-zinc-50" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
      }`}
    >
      <span aria-hidden className="[&_svg]:size-4">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {badge > 0 && (
        <span aria-hidden className="min-w-5 rounded-full bg-red-600 px-1.5 text-center text-[11px] leading-5 font-bold text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}
