import { redirect } from "next/navigation";
import { Suspense } from "react";
import { CreateCommunityDialog } from "@/components/app/create-community-dialog";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { listCommunities } from "@/server/communities";
import { requirePageUser } from "@/server/session";

export default function AppHome() {
  return (
    <main className="flex flex-1 flex-col">
      <header className="flex h-12 items-center gap-2 border-b px-3 md:hidden">
        <MobileNavToggle />
      </header>
      <Suspense fallback={<p className="m-auto text-muted-foreground">Loading…</p>}>
        <Home />
      </Suspense>
    </main>
  );
}

async function Home() {
  const user = await requirePageUser();
  const communities = await listCommunities(user.id);
  if (communities.length > 0) redirect(`/app/c/${communities[0].id}`);

  return (
    <section className="m-auto max-w-md space-y-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">Welcome, {user.name}</h1>
      <p className="text-muted-foreground">
        You&apos;re not in any community yet. Start your own, or open an invite link someone shared with you.
      </p>
      <CreateCommunityDialog trigger="button" />
    </section>
  );
}
