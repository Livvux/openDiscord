import type { Metadata } from "next";
import { Suspense } from "react";
import { BanAppealForm } from "@/components/app/ban-appeals";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { listOwnAppealHistory, listOwnRestrictions } from "@/server/community-trust";
import { requirePageUser } from "@/server/session";
import { DiamondOrbitSmoothLoader } from "@/components/ui/diamond-orbit-smooth-loader";

export const metadata: Metadata = { title: "Your community restrictions" };
export default function RestrictionsPage() {
  return <main className="min-w-0 flex-1 overflow-y-auto"><header className="flex min-h-12 items-center gap-2 border-b px-3"><MobileNavToggle /><h1 className="font-semibold">Your community restrictions</h1></header><Suspense fallback={<div className="p-6 text-primary"><DiamondOrbitSmoothLoader /></div>}><Restrictions /></Suspense></main>;
}
async function Restrictions() {
  const user = await requirePageUser();
  const [restrictions, history] = await Promise.all([listOwnRestrictions(user.id), listOwnAppealHistory(user.id)]);
  return <div className="mx-auto grid max-w-2xl gap-6 p-6">
    <p className="text-muted-foreground">Bans prevent joining and accessing a community. Only your own restrictions appear here. Reviews are handled by that community&apos;s moderators.</p>
    {restrictions.length === 0 && <p>You have no active community bans.</p>}
    {restrictions.map((r) => <section key={r.communityId} className="grid min-w-0 gap-3 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">{r.communityName}</h2>
      <p className="whitespace-pre-wrap break-words">Reason: {r.reason || "No reason was provided."}</p>
      {r.appealId ? <><p className="whitespace-pre-wrap break-words">Your appeal: {r.content}</p><p role="status">{r.resolution === "uphold" ? "Review complete: the ban was upheld." : "Your appeal is awaiting review."}</p>{r.resolutionNote && <p className="whitespace-pre-wrap break-words">Moderator reply: {r.resolutionNote}</p>}</> : <BanAppealForm communityId={r.communityId} />}
    </section>)}
    {history.some((a) => a.resolution) && <section className="grid gap-3"><h2 className="text-lg font-semibold">Resolved appeals</h2>{history.filter((a) => a.resolution).map((a) => <div key={a.id} className="grid gap-2 rounded-lg border p-4"><h3 className="font-medium">{a.communityName}</h3><p>{a.resolution === "unban" ? "Review complete: the ban was removed. You can join again with a valid invite." : "Review complete: the ban was upheld."}</p>{a.resolutionNote && <p className="whitespace-pre-wrap break-words">Moderator reply: {a.resolutionNote}</p>}</div>)}</section>}
  </div>;
}
