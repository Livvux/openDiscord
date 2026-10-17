import { HomeIcon, MailIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { HomeNavLink } from "@/components/app/home/home-nav-link";
import { MobilePanel } from "@/components/app/mobile-nav";
import { PresenceAvatar } from "@/components/app/presence-avatar";
import { HomeRefresher } from "@/components/app/home/home-refresher";
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
  const [friends, { incomingRequests }] = await Promise.all([homeFriends(user.id), homeConversations(user.id)]);
  const online = friends.filter((f) => f.state === "friend" && f.presence);
  const incoming = friends.filter((f) => f.state === "incoming").length;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
      <ul className="space-y-0.5">
        <li><HomeNavLink href="/app" icon={<HomeIcon />} label="Overview" /></li>
        <li><HomeNavLink href="/app/friends" icon={<UsersIcon />} label="Friends" badge={incoming} /></li>
        <li><HomeNavLink href="/app/messages" icon={<MailIcon />} label="Private messages" badge={incomingRequests} /></li>
      </ul>
      <h3 className="px-2 pt-5 pb-1 text-[11px] tracking-widest text-zinc-400 uppercase">Online friends — {online.length}</h3>
      {online.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">Nobody online right now.</p>
      ) : (
        <ul className="space-y-0.5">
          {online.map((f) => (
            <li key={f.id}>
              <Link
                href={`/app/messages?to=${encodeURIComponent(f.id)}`}
                aria-label={`Message ${f.name}`}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-zinc-300 hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <PresenceAvatar userId={f.id} name={f.name} size="sm" status={f.presence} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{f.name}</span>
                  {f.customStatus && <span className="block truncate text-xs text-muted-foreground">{f.customStatus}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
