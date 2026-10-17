import type { Metadata } from "next";
import { Suspense } from "react";
import { PrivateMessages } from "@/components/app/dm/private-messages";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Private messages" };
export default function PrivateMessagesPage({ searchParams }: PageProps<"/app/messages">) {
  return <main className="flex min-w-0 flex-1 flex-col"><header className="flex min-h-12 items-center gap-2 border-b px-3"><MobileNavToggle /><h1 className="font-semibold">Private messages</h1></header><Suspense fallback={<p className="p-6">Loading private messages…</p>}><Messages searchParams={searchParams} /></Suspense></main>;
}
async function Messages({ searchParams }: Pick<PageProps<"/app/messages">, "searchParams">) {
  const user = await requirePageUser();
  const params = await searchParams;
  const target = typeof params.to === "string" && params.to.length <= 64 && params.to !== user.id ? params.to : undefined;
  // Remount per target so a new ?to= selects its conversation (the encryption client is cached).
  return <PrivateMessages key={target ?? ""} userId={user.id} target={target} />;
}
