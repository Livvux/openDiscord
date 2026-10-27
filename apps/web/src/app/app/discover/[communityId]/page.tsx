import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { JoinButton } from "@/app/invite/[code]/join-button";
import { communityInitials } from "@/components/app/community-icon";
import { bannerStyle, MemberCounts } from "@/components/app/discover/community-card";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { buttonVariants } from "@/components/ui/button";
import { DiamondOrbitSmoothLoader } from "@/components/ui/diamond-orbit-smooth-loader";
import { getDiscoverable } from "@/server/discovery";
import { loadCommunityNavigation } from "@/server/pages";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Discover" };

export default function DiscoverCommunityPage({ params }: PageProps<"/app/discover/[communityId]">) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2 md:pl-4">
        <MobileNavToggle />
        <Link href="/app/discover" className="flex items-center gap-2 text-muted-foreground hover:text-foreground"><ArrowLeftIcon aria-hidden className="size-5" />Servers</Link>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Suspense fallback={<div className="grid h-full place-items-center text-primary"><DiamondOrbitSmoothLoader /></div>}>
          <Preview params={params} />
        </Suspense>
      </div>
    </main>
  );
}

async function Preview({ params }: Pick<PageProps<"/app/discover/[communityId]">, "params">) {
  const user = await requirePageUser();
  const { communityId } = await params;
  const [c, joined] = await Promise.all([getDiscoverable(communityId), loadCommunityNavigation(user.id)]);
  if (!c) notFound();
  const member = joined.some((j) => j.id === c.id);
  return (
    <article className="mx-auto max-w-2xl p-4 md:p-6">
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-white/5">
        <div aria-hidden className="h-36" style={bannerStyle(c.id)} />
        <div className="relative grid gap-4 px-6 pt-12 pb-6">
          <span aria-hidden className="absolute -top-10 left-5 grid size-20 place-items-center rounded-3xl bg-sidebar text-2xl font-semibold text-sidebar-foreground ring-[6px] ring-card">
            {communityInitials(c.name)}
          </span>
          <div className="grid gap-2">
            <h1 className="text-2xl font-bold break-words">{c.name}</h1>
            <MemberCounts online={c.onlineCount} members={c.memberCount} />
          </div>
          {c.description && <p className="whitespace-pre-wrap break-words text-muted-foreground">{c.description}</p>}
          {c.rules && (
            <section className="grid max-h-72 gap-2 overflow-y-auto rounded-lg border p-3">
              <h2 className="font-semibold">Community rules</h2>
              <p className="whitespace-pre-wrap break-words text-sm">{c.rules}</p>
            </section>
          )}
          {member
            ? <Link href={`/app/c/${c.id}`} className={buttonVariants({ size: "lg" })}>Open community</Link>
            : <JoinButton communityId={c.id} rulesVersion={c.rulesVersion} rulesRequired={c.rulesRequired} />}
        </div>
      </div>
    </article>
  );
}
