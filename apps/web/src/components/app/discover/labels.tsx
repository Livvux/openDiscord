"use client";

import { CompassIcon } from "lucide-react";
import { fmt } from "@/lib/i18n";
import { useLocale, useMessages } from "@/lib/i18n/client";
import { HomeNavLink } from "../home/home-nav-link";

export function DiscoverTitle() {
  return <>{useMessages().discover.servers}</>;
}

export function MemberCounts({ online, members }: { online: number; members: number }) {
  const t = useMessages().discover;
  const locale = useLocale();
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-[#23a55a]" />{fmt(t.online, { count: online.toLocaleString(locale) })}</span>
      <span className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-muted-foreground" />{fmt(members === 1 ? t.member : t.members, { count: members.toLocaleString(locale) })}</span>
    </p>
  );
}

export function DiscoverHeading() {
  return <>{useMessages().discover.title}</>;
}

export function DiscoverNavLink() {
  return <HomeNavLink href="/app/discover" icon={<CompassIcon />} label={useMessages().discover.servers} />;
}
