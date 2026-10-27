import { MailIcon, UsersIcon } from "lucide-react";
import { Suspense } from "react";
import { DmDeviceBootstrap } from "@/components/app/dm/dm-device-bootstrap";
import { DirectMessageList } from "@/components/app/home/direct-message-list";
import { HomeNavLink } from "@/components/app/home/home-nav-link";
import { HomeRefresher } from "@/components/app/home/home-refresher";
import { MobilePanel } from "@/components/app/mobile-nav";
import type { PresenceStatus } from "@/lib/presence";
import { homeConversations, homeFriends } from "@/server/home";
import { loadCommunityNavigation } from "@/server/pages";
import { QuickSwitcher } from "@/components/app/home/quick-switcher";
import { requirePageUser } from "@/server/session";
import { DiamondOrbitSmoothLoader } from "@/components/ui/diamond-orbit-smooth-loader";

export default function HomeLayout({ children }: LayoutProps<"/app">) {
  return (
    <>
      <MobilePanel label="Home" data-sidebar className="flex w-(--sidebar-w) shrink-0 flex-col border-r bg-panel max-md:left-(--rail-w)">
        <h2 className="sr-only">Home</h2>
        <Suspense fallback={<><div className="h-12 shrink-0 border-b" /><div className="p-4 text-primary"><DiamondOrbitSmoothLoader dotSize={4} gap={3} /></div></>}>
          <HomeSidebar />
        </Suspense>
      </MobilePanel>
      <HomeRefresher />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </>
  );
}

async function HomeSidebar() {
  const user = await requirePageUser();
  const [friends, { recent, incomingRequests }, communities] = await Promise.all([homeFriends(user.id), homeConversations(user.id), loadCommunityNavigation(user.id)]);
  const incoming = friends.filter((f) => f.state === "incoming").length;
  const presence: Record<string, PresenceStatus> = Object.fromEntries(friends.flatMap((f) => (f.presence ? [[f.id, f.presence]] : [])));
  const relations = Object.fromEntries(friends.map((f) => [f.id, f.state]));
  return (
    <>
    <header className="flex h-12 shrink-0 items-center border-b px-2.5">
      <QuickSwitcher communities={communities.map(({ id, name, iconId }) => ({ id, name, iconId }))} initial={recent} />
    </header>
    {/* Bottom padding keeps the last conversations above the floating user panel. */}
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-2 pb-20">
      <DmDeviceBootstrap userId={user.id} />
      <ul className="space-y-0.5">
        <li><HomeNavLink href="/app" icon={<UsersIcon />} label="Friends" badge={incoming} /></li>
        <li><HomeNavLink href="/app/messages" icon={<MailIcon />} label="Message requests" badge={incomingRequests} /></li>
      </ul>
      <div aria-hidden className="mx-2 my-2 h-px bg-border" />
      <h3 className="px-2 pt-2 pb-1 text-sm font-medium text-muted-foreground">Direct Messages</h3>
      <DirectMessageList userId={user.id} initial={recent} presence={presence} relations={relations} />
    </div>
    </>
  );
}
