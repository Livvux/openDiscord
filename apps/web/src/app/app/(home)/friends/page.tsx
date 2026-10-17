import type { Metadata } from "next";
import { Suspense } from "react";
import { FriendsView } from "@/components/app/home/friends-view";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { homeFriends } from "@/server/home";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Friends" };

export default function FriendsPage({ searchParams }: PageProps<"/app/friends">) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <MobileNavToggle />
        <h1 className="px-1 font-semibold">Friends</h1>
      </header>
      <Suspense fallback={<p className="m-auto text-muted-foreground">Loading…</p>}>
        <Friends searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Friends({ searchParams }: Pick<PageProps<"/app/friends">, "searchParams">) {
  const user = await requirePageUser();
  const [friends, params] = await Promise.all([homeFriends(user.id), searchParams]);
  // A shared friend link (?add=<code>) prefills the form; nothing is sent until the person confirms.
  const add = typeof params.add === "string" && params.add.length <= 64 && params.add !== user.id ? params.add : "";
  return <FriendsView key={add} userId={user.id} friends={friends} initialCode={add} />;
}
