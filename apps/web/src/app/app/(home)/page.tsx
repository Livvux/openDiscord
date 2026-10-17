import { AtSignIcon, MailIcon, UserPlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Avatar } from "@/components/app/avatar";
import { CreateCommunityDialog } from "@/components/app/create-community-dialog";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { PresenceAvatar } from "@/components/app/presence-avatar";
import { UserContextMenu } from "@/components/app/user-context-menu";
import { ServerContextMenu } from "@/components/app/server-context-menu";
import { listCommunityNavigation } from "@/server/communities";
import { homeConversations, homeFriends } from "@/server/home";
import { mutedCommunities } from "@/server/presence";
import { requirePageUser } from "@/server/session";
import { communityUnread } from "@/server/unread";

export const metadata: Metadata = { title: "Home" };

export default function AppHome() {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <MobileNavToggle />
        <h1 className="px-1 font-semibold">Home</h1>
      </header>
      <Suspense fallback={<p className="m-auto text-muted-foreground">Loading…</p>}>
        <Home />
      </Suspense>
    </main>
  );
}

const card = "rounded-xl border border-white/5 bg-panel/60 p-4";
const rowLink = "flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-ring";
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes > -60) return relative.format(minutes, "minute");
  if (minutes > -1440) return relative.format(Math.round(minutes / 60), "hour");
  return relative.format(Math.round(minutes / 1440), "day");
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  const id = `home-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={card}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id={id} className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

async function Home() {
  const user = await requirePageUser();
  const [communities, friends, dms] = await Promise.all([listCommunityNavigation(user.id), homeFriends(user.id), homeConversations(user.id)]);
  const [unread, muted] = await Promise.all([communityUnread(user.id, communities), mutedCommunities(user.id, communities.map((c) => c.id))]);
  const incomingFriends = friends.filter((f) => f.state === "incoming");
  const accepted = friends.filter((f) => f.state === "friend");
  const online = accepted.filter((f) => f.presence);
  const mentioned = communities.filter((c) => (unread.get(c.id)?.mentions ?? 0) > 0);
  const attention = incomingFriends.length + dms.incomingRequests + mentioned.length;
  const fresh = communities.length === 0 && accepted.length === 0 && dms.recent.length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-5xl gap-4 p-4 md:p-6">
        <div>
          <h2 className="text-2xl font-semibold text-zinc-50">Welcome, {user.name}</h2>
          <p className="text-muted-foreground">
            {attention > 0 ? `${attention} ${attention === 1 ? "thing needs" : "things need"} your attention.` : "You're all caught up."}
          </p>
        </div>

        {fresh && (
          <section aria-labelledby="home-start" className={`${card} grid gap-3 md:grid-cols-[1fr_auto] md:items-center`}>
            <div>
              <h2 id="home-start" className="font-semibold">Get started</h2>
              <p className="text-sm text-muted-foreground">Start your own community, open an invite link someone shared, or add a friend with their friend code.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <CreateCommunityDialog trigger="button" />
              <Link href="/app/friends" className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium hover:bg-muted"><UserPlusIcon className="size-4" />Add a friend</Link>
            </div>
          </section>
        )}

        {attention > 0 && (
          <Card title="Needs attention">
            <ul className="grid gap-0.5">
              {incomingFriends.length > 0 && (
                <li><Link href="/app/friends" className={rowLink}><UserPlusIcon className="size-4 text-brand-mint" /><span>{incomingFriends.length} friend {incomingFriends.length === 1 ? "request" : "requests"} from {incomingFriends.slice(0, 2).map((f) => f.name).join(", ")}{incomingFriends.length > 2 ? " and others" : ""}</span></Link></li>
              )}
              {dms.incomingRequests > 0 && (
                <li><Link href="/app/messages" className={rowLink}><MailIcon className="size-4 text-brand-mint" /><span>{dms.incomingRequests} private message {dms.incomingRequests === 1 ? "request" : "requests"}</span></Link></li>
              )}
              {mentioned.map((c) => (
                <li key={c.id}><Link href={`/app/c/${c.id}`} className={rowLink}><AtSignIcon className="size-4 text-red-400" /><span>{unread.get(c.id)!.mentions} {unread.get(c.id)!.mentions === 1 ? "mention" : "mentions"} in {c.name}</span></Link></li>
              ))}
            </ul>
          </Card>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Recent conversations" action={<Link href="/app/messages" className="text-xs text-zinc-400 hover:text-zinc-100">All messages</Link>}>
            {dms.recent.length === 0 ? (
              <p className="px-2 py-1 text-sm text-muted-foreground">No private conversations yet. Message a friend or a community member to start an end-to-end encrypted chat.</p>
            ) : (
              <ul className="grid gap-0.5">
                {dms.recent.map((c) => (
                  <li key={c.id}>
                    <UserContextMenu userId={c.peerId} name={c.peerName} currentUserId={user.id} blocked={c.ownBlocked} relation={friends.find((f) => f.id === c.peerId)?.state ?? null}>
                      <Link href={`/app/messages?to=${encodeURIComponent(c.peerId)}`} className={rowLink}>
                        <Avatar name={c.peerName} size="sm" />
                        <span className="min-w-0 flex-1 truncate">{c.peerName}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {c.status === "pending" ? (c.requestedBy === user.id ? "Request sent" : "Wants to message you") : c.lastActivity ? ago(c.lastActivity) : "No messages yet"}
                        </span>
                      </Link>
                    </UserContextMenu>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Friends online — ${online.length}`} action={<Link href="/app/friends" className="text-xs text-zinc-400 hover:text-zinc-100">All friends</Link>}>
            {accepted.length === 0 ? (
              <p className="px-2 py-1 text-sm text-muted-foreground">No friends yet. <Link href="/app/friends" className="text-zinc-100 underline underline-offset-2">Add one</Link> from your communities or with a friend code.</p>
            ) : online.length === 0 ? (
              <p className="px-2 py-1 text-sm text-muted-foreground">None of your {accepted.length} {accepted.length === 1 ? "friend is" : "friends are"} showing as online.</p>
            ) : (
              <ul className="grid gap-0.5">
                {online.slice(0, 8).map((f) => (
                  <li key={f.id}>
                    <UserContextMenu userId={f.id} name={f.name} currentUserId={user.id} relation={f.state}>
                      <Link href={`/app/messages?to=${encodeURIComponent(f.id)}`} aria-label={`Message ${f.name}`} className={rowLink}>
                        <PresenceAvatar userId={f.id} name={f.name} size="sm" status={f.presence} announce />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{f.name}</span>
                          {f.customStatus && <span className="block truncate text-xs text-muted-foreground">{f.customStatus}</span>}
                        </span>
                      </Link>
                    </UserContextMenu>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card title="Your communities" action={communities.length > 0 ? <CreateCommunityDialog trigger="button" /> : undefined}>
          {communities.length === 0 ? (
            <p className="px-2 py-1 text-sm text-muted-foreground">You&apos;re not in any community yet. Create one, or open an invite link someone shared with you.</p>
          ) : (
            <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {communities.map((c) => {
                const state = unread.get(c.id);
                const isMuted = muted.has(c.id);
                return (
                  <li key={c.id}>
                    <ServerContextMenu community={c}>
                      <Link href={`/app/c/${c.id}`} className={`${rowLink} border border-white/5`}>
                        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/5 text-xs font-semibold text-zinc-200">
                          {c.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]?.toUpperCase()).join("")}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate ${state?.unread && !isMuted ? "font-semibold text-zinc-50" : "text-zinc-300"}`}>{c.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {state?.mentions ? `${state.mentions} ${state.mentions === 1 ? "mention" : "mentions"}` : state?.unread && !isMuted ? "New messages" : isMuted ? "Muted" : "Up to date"}
                          </span>
                        </span>
                      </Link>
                    </ServerContextMenu>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
