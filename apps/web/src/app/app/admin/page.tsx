import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AdminPanel } from "@/components/app/settings/instance-admin";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { adminDashboard, requireInstanceAdmin } from "@/server/instance-admin";
import { orNotFound } from "@/server/pages";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Instance administration" };

export default function AdminPage({ searchParams }: PageProps<"/app/admin">) {
  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <header className="flex min-h-12 items-center gap-2 border-b px-3">
        <MobileNavToggle /><h1 className="font-semibold">Instance administration</h1>
        <Link href="/app/settings" className="ml-auto text-muted-foreground underline">Account settings</Link>
      </header>
      <Suspense fallback={<p className="p-6">Loading administration…</p>}>
        <Administration searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
async function Administration({ searchParams }: Pick<PageProps<"/app/admin">, "searchParams">) {
  const user = await requirePageUser();
  const actor = { userId: user.id, sessionId: user.sessionId };
  await orNotFound(requireInstanceAdmin(actor));
  const params = await searchParams;
  const search = typeof params.q === "string" ? params.q.slice(0, 100) : "";
  const status = typeof params.status === "string" && ["open", "dismissed", "removed"].includes(params.status) ? params.status : "open";
  const data = await adminDashboard(actor, search, status);
  return <AdminPanel data={data} search={search} status={status} />;
}
