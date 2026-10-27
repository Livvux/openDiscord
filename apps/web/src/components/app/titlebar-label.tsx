"use client";

import { BanIcon, CompassIcon, MailIcon, SettingsIcon, ShieldIcon, UsersIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { CommunityIcon } from "./community-icon";

const PAGES: [prefix: string, label: string, icon: React.ReactNode][] = [
  ["/app/messages", "Direct Messages", <MailIcon key="m" />],
  ["/app/settings", "User Settings", <SettingsIcon key="s" />],
  ["/app/admin", "Instance administration", <ShieldIcon key="a" />],
  ["/app/discover", "Discover", <CompassIcon key="d" />],
  ["/app/restrictions", "Community restrictions", <BanIcon key="r" />],
  ["/app", "Friends", <UsersIcon key="f" />],
];

export function TitlebarLabel({ communities }: { communities: Record<string, { name: string; iconId: string | null }> }) {
  const pathname = usePathname();
  const communityId = pathname.match(/^\/app\/c\/([^/]+)/)?.[1];
  const community = communityId ? communities[communityId] : undefined;
  const page = PAGES.find(([prefix]) => pathname.startsWith(prefix));
  if (community) {
    return <p className="flex min-w-0 items-center gap-2"><CommunityIcon name={community.name} iconId={community.iconId} size="xs" /><span className="truncate">{community.name}</span></p>;
  }
  if (!page || communityId) return null;
  return <p className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-muted-foreground">{page[2]}{page[1]}</p>;
}
