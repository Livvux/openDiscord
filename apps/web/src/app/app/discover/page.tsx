import { CompassIcon, SearchIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CommunityCard } from "@/components/app/discover/community-card";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { DiamondOrbitSmoothLoader } from "@/components/ui/diamond-orbit-smooth-loader";
import { listDiscoverable } from "@/server/discovery";
import { listPublicChannels } from "@/server/public-channels";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Discover" };

export default function DiscoverPage({ searchParams }: PageProps<"/app/discover">) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2 md:pl-4">
        <MobileNavToggle />
        <CompassIcon aria-hidden className="size-5 text-muted-foreground" />
        <h1 className="text-base font-semibold">Servers</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Suspense fallback={<div className="grid h-full place-items-center text-primary"><DiamondOrbitSmoothLoader /></div>}>
          <Directory searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

async function Directory({ searchParams }: Pick<PageProps<"/app/discover">, "searchParams">) {
  await requirePageUser();
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim().slice(0, 100) : "";
  const [communities, { channels }] = await Promise.all([listDiscoverable(query), query ? { channels: [] } : listPublicChannels()]);
  return (
    <div className="mx-auto grid max-w-6xl gap-8 p-4 md:p-6">
      <section className="relative grid min-h-56 place-items-center overflow-hidden rounded-xl bg-[linear-gradient(135deg,#5865f2,#3b3fbf_55%,#1e1f6b)] px-6 py-10 text-center text-white">
        <div className="grid w-full max-w-xl gap-4">
          <h2 className="text-2xl font-extrabold text-balance md:text-3xl">Find your community on openDiscord</h2>
          <form role="search" action="/app/discover" className="relative">
            <label htmlFor="discover-search" className="sr-only">Explore communities</label>
            <input
              id="discover-search"
              name="q"
              type="search"
              defaultValue={query}
              maxLength={100}
              placeholder="Explore communities"
              className="h-11 w-full rounded-lg bg-white pr-11 pl-4 text-base text-neutral-900 placeholder:text-neutral-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            />
            <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 size-5 -translate-y-1/2 text-neutral-500" />
          </form>
        </div>
      </section>

      <section aria-labelledby="communities-heading" className="grid gap-4">
        <h2 id="communities-heading" className="text-xl font-bold">{query ? `Results for “${query}”` : "Featured communities"}</h2>
        {communities.length ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
            {communities.map((c) => <CommunityCard key={c.id} community={c} />)}
          </ul>
        ) : (
          <p className="text-muted-foreground">
            {query ? <>No communities match. <Link href="/app/discover" className="link">Show all</Link></> : "No public communities yet. Owners can list theirs in Community settings → Overview."}
          </p>
        )}
      </section>

      {channels.length > 0 && (
        <section aria-labelledby="channels-heading" className="grid gap-4">
          <h2 id="channels-heading" className="text-xl font-bold">Public channels</h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-2">
            {channels.map((ch) => (
              <li key={ch.id}>
                <a href={`/public/${ch.id}`} className="grid rounded-lg bg-card px-4 py-3 ring-1 ring-white/5 hover:ring-white/15 focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="truncate text-xs text-muted-foreground">{ch.communityTitle}</span>
                  <span className="truncate font-medium">#{ch.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
