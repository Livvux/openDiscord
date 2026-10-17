import { MailIcon, UsersIcon } from "lucide-react";
import { Suspense } from "react";
import { DmDeviceBootstrap } from "@/components/app/dm/dm-device-bootstrap";
import { DirectMessageList } from "@/components/app/home/direct-message-list";
import { HomeNavLink } from "@/components/app/home/home-nav-link";
import { HomeRefresher } from "@/components/app/home/home-refresher";
import { MobilePanel } from "@/components/app/mobile-nav";
import type { PresenceStatus } from "@/lib/presence";
import { homeConversations, homeFriends } from "@/server/home";
import { requirePageUser } from "@/server/session";

export default function HomeLayout({ children }: LayoutProps<"/app">) {
  return (
    <>
      <MobilePanel label="Home" className="flex w-60 shrink-0 flex-col border-r border-white/5 bg-panel max-md:left-16">
        <header className="flex h-12 items-center border-b border-white/5 px-5">
          <h2 className="font-semibold text-zinc-100">Home</h2>
        </header>
        <Suspense fallback={<p className="p-4 text-xs text-muted-foreground">Loading…</p>}>
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
  const [friends, { recent, incomingRequests }] = await Promise.all([homeFriends(user.id), homeConversations(user.id)]);
  const incoming = friends.filter((f) => f.state === "incoming").length;
  const presence: Record<string, PresenceStatus> = Object.fromEntries(friends.flatMap((f) => (f.presence ? [[f.id, f.presence]] : [])));
  const relations = Object.fromEntries(friends.map((f) => [f.id, f.state]));
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
      <DmDeviceBootstrap userId={user.id} />
      <ul className="space-y-0.5">
        <li><HomeNavLink href="/app" icon={<UsersIcon />} label="Friends" badge={incoming} /></li>
        <li><HomeNavLink href="/app/messages" icon={<MailIcon />} label="Message requests" badge={incomingRequests} /></li>
      </ul>
      <h3 className="px-2 pt-5 pb-1 text-[11px] tracking-widest text-zinc-400 uppercase">Direct messages</h3>
      <DirectMessageList userId={user.id} initial={recent} presence={presence} relations={relations} />
    </div>
  );
}
