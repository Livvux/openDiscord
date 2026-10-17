import { UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { FriendsView } from "@/components/app/home/friends-view";
import { ActiveNow } from "@/components/app/home/active-now";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { listBlocked } from "@/server/blocks";
import { homeFriends } from "@/server/home";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Friends" };

/** Home is the friends list, as in Discord. A shared friend link (?add=<code>) opens Add Friend prefilled. */
export default function AppHome({ searchParams }: PageProps<"/app">) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <MobileNavToggle />
        <UsersIcon aria-hidden className="size-5 text-zinc-400" />
        <h1 className="px-1 font-semibold">Friends</h1>
      </header>
      <Suspense fallback={<p className="m-auto text-muted-foreground">Loading…</p>}>
        <Friends searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Friends({ searchParams }: Pick<PageProps<"/app">, "searchParams">) {
  const user = await requirePageUser();
  const [friends, blocked, params] = await Promise.all([homeFriends(user.id), listBlocked(user.id), searchParams]);
  // Nothing is sent until the person confirms the prefilled code.
  const add = typeof params.add === "string" && params.add.length <= 64 && params.add !== user.id ? params.add : "";
  return (
    <div className="flex min-h-0 flex-1">
      <FriendsView key={add} userId={user.id} friends={friends} blocked={blocked} initialCode={add} />
      <ActiveNow userId={user.id} friends={friends.filter((f) => f.state === "friend" && f.presence)} />
    </div>
  );
}
