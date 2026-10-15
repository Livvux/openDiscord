import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ADMIN_TABS, type AdminTab, AdminPanel } from "@/components/app/admin/admin-panel";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { adminDashboard, requireInstanceAdmin, USER_FILTERS, type UserFilter } from "@/server/instance-admin";
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
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  const status = pick(params.status, ["open", "dismissed", "removed"], "open");
  const tab = pick<AdminTab>(params.tab, ADMIN_TABS, "overview");
  const filter = pick<UserFilter>(params.filter, USER_FILTERS, "all");
  const data = await adminDashboard(actor, search, status, filter);
  return <AdminPanel data={data} tab={tab} search={search} status={status} />;
}
