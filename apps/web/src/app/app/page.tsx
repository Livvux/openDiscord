import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { SignOutButton } from "./sign-out-button";

export default function AppPage() {
  return (
    <div className="flex flex-1">
      <aside className="w-18 shrink-0 border-r border-zinc-800 bg-zinc-900" aria-label="Communities" />
      <main className="flex flex-1 flex-col">
        <header className="flex h-12 items-center justify-between border-b border-zinc-800 px-4">
          <span className="font-semibold">opendiscord</span>
          <Suspense fallback={<span className="text-sm text-zinc-500">Loading…</span>}>
            <CurrentUser />
          </Suspense>
        </header>
        <p className="m-auto text-zinc-500">No communities yet.</p>
      </main>
    </div>
  );
}

async function CurrentUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-zinc-400">{session.user.name}</span>
      <SignOutButton />
    </div>
  );
}
