"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { unreadTotal } from "@/lib/dm/contracts";
import { useDirectConversations } from "../notifications-provider";
import { RailBadge, RailPill, railTile } from "../rail-link";

const HOME_PATHS = ["/app", "/app/friends", "/app/messages"];

/** The rail's Home button: active anywhere in the personal area; badge = unread private messages. */
export function RailHomeLink({ initialUnread = 0 }: { initialUnread?: number }) {
  const active = HOME_PATHS.includes(usePathname());
  const { direct } = useDirectConversations();
  const unread = direct ? unreadTotal(direct) : initialUnread;
  return (
    <div className="group/rail relative mt-2">
      <RailPill active={active} unread={false} />
      <Link
        href="/app"
        aria-label={unread > 0 ? `Home, ${unread} unread private ${unread === 1 ? "message" : "messages"}` : "Home"}
        aria-current={active ? "page" : undefined}
        title="Home"
        className={railTile(active)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- static SVG, no optimisation needed */}
        <img src="/brand/symbol-flat.svg" alt="" width={28} height={28} />
        <RailBadge count={unread} data="data-home-unread" />
      </Link>
    </div>
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
      className={`flex h-10 items-center gap-3 rounded-lg px-2 text-base font-medium focus-visible:outline-2 focus-visible:outline-ring ${
        active ? "bg-white/10 text-sidebar-foreground" : "text-muted-foreground hover:bg-white/5 hover:text-sidebar-foreground"
      }`}
    >
      <span aria-hidden className="[&_svg]:size-5">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {badge > 0 && (
        <span aria-hidden className="min-w-4 rounded-full bg-[#dc2626] px-1 text-center text-xs leading-4 font-bold text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}
