import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PrivateReports } from "@/components/app/admin/private-reports";
import { listDirectReports } from "@/server/direct-messages";
import { orNotFound } from "@/server/pages";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Private message reports" };
export default function PrivateReportsPage() {
  return <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-8"><Link href="/app/admin?tab=reports" className="underline">Instance moderation</Link><h1 className="mt-4 text-2xl font-semibold">Private message reports</h1><p className="mt-2 max-w-3xl text-muted-foreground">Only the recipient&apos;s reason and any text they explicitly chose to disclose appear here. Excerpts are recipient statements, not cryptographic proof; the server cannot decrypt or authenticate their claimed plaintext.</p><Suspense fallback={<p className="py-6">Loading reports…</p>}><Reports /></Suspense></main>;
}
async function Reports() {
  const user = await requirePageUser();
  const reports = await orNotFound(listDirectReports({ userId: user.id, sessionId: user.sessionId }));
  return <PrivateReports reports={reports} />;
}
