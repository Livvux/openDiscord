import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { JoinButton } from "@/app/invite/[code]/join-button";
import { CommunityPicture } from "@/components/app/community-icon";
import { bannerStyle, CommunityName, MemberCounts } from "@/components/app/discover/community-card";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { buttonVariants } from "@/components/ui/button";
import { DiamondOrbitSmoothLoader } from "@/components/ui/diamond-orbit-smooth-loader";
import { getDiscoverable } from "@/server/discovery";
import { loadCommunityNavigation } from "@/server/pages";
import { requirePageUser } from "@/server/session";
import { getMessages } from "@/lib/i18n/server";
import { DiscoverTitle } from "@/components/app/discover/community-card";

export const metadata: Metadata = { title: "Discover" };

export default function DiscoverCommunityPage({ params }: PageProps<"/app/discover/[communityId]">) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2 md:pl-4">
        <MobileNavToggle />
        <Link href="/app/discover" className="flex items-center gap-2 text-muted-foreground hover:text-foreground"><ArrowLeftIcon aria-hidden className="size-5" /><DiscoverTitle /></Link>
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
  const [c, joined, { discover: t }] = await Promise.all([getDiscoverable(communityId), loadCommunityNavigation(user.id), getMessages()]);
  if (!c) notFound();
  const member = joined.some((j) => j.id === c.id);
  return (
    <article className="mx-auto max-w-2xl p-4 md:p-6">
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-white/5">
        <div aria-hidden className="aspect-[16/6] max-h-60" style={bannerStyle(c.id, c.bannerId)} />
        <div className="relative grid gap-4 px-6 pt-12 pb-6">
          <span aria-hidden className="absolute -top-10 left-5 grid size-20 place-items-center overflow-hidden rounded-3xl bg-sidebar text-2xl font-semibold text-sidebar-foreground ring-[6px] ring-card">
            <CommunityPicture name={c.name} iconId={c.iconId} />
          </span>
          <div className="grid gap-2">
            <CommunityName as="h1" name={c.name} verified={c.verified} className="text-2xl font-bold" />
            <MemberCounts online={c.onlineCount} members={c.memberCount} />
          </div>
          {c.description && <p className="whitespace-pre-wrap break-words text-muted-foreground">{c.description}</p>}
          {c.rules && (
            <section className="grid max-h-72 gap-2 overflow-y-auto rounded-lg border p-3">
              <h2 className="font-semibold">{t.rules}</h2>
              <p className="whitespace-pre-wrap break-words text-sm">{c.rules}</p>
            </section>
          )}
          {member
            ? <Link href={`/app/c/${c.id}`} className={buttonVariants({ size: "lg" })}>{t.open}</Link>
            : <JoinButton communityId={c.id} rulesVersion={c.rulesVersion} rulesRequired={c.rulesRequired} />}
        </div>
      </div>
    </article>
  );
}
