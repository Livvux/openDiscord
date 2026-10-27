import { UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { FriendsView } from "@/components/app/home/friends-view";
import { ActiveNow } from "@/components/app/home/active-now";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { listBlocked } from "@/server/blocks";
import { homeFriends } from "@/server/home";
import { listPublicChannels } from "@/server/public-channels";
import { requirePageUser } from "@/server/session";
import { DiamondOrbitSmoothLoader } from "@/components/ui/diamond-orbit-smooth-loader";

export const metadata: Metadata = { title: "Friends" };

/** Home is the friends list, as in Discord. A shared friend link (?add=<code>) opens Add Friend prefilled. */
export default function AppHome({ searchParams }: PageProps<"/app">) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<><header className="flex h-12 shrink-0 items-center gap-2 border-b px-2 md:pl-4"><MobileNavToggle /><UsersIcon aria-hidden className="size-5 text-muted-foreground" /><h1 className="text-base font-semibold">Friends</h1></header><div className="m-auto text-primary"><DiamondOrbitSmoothLoader /></div></>}>
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
  // Only newcomers see the getting-started links; skip the query for everyone else.
  const hasPublicChannels = friends.length === 0 && (await listPublicChannels()).channels.length > 0;
  return (
    <FriendsView key={add} userId={user.id} friends={friends} blocked={blocked} initialCode={add} hasPublicChannels={hasPublicChannels}
      aside={<ActiveNow userId={user.id} friends={friends.filter((f) => f.state === "friend" && f.presence)} />} />
  );
}
