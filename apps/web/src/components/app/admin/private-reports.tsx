"use client";

import Link from "next/link";
import { resolvePrivateReport } from "@/app/app/admin/actions";
import type { listDirectReports } from "@/server/direct-messages";
import { QuickAction } from "./admin-action";

export function PrivateReports({ reports }: { reports: Awaited<ReturnType<typeof listDirectReports>> }) {
  if (!reports.length) return <p className="py-6">No open private message reports.</p>;
  return <ul className="mt-6 grid gap-4">{reports.map((report) => <li key={report.id} className="grid gap-3 rounded-xl border p-4"><h2 className="font-semibold">Reported sender: {report.senderName}</h2><p className="whitespace-pre-wrap break-words">{report.reason}</p>{report.excerpt === null ? <p className="text-sm text-muted-foreground">No message text was disclosed.</p> : <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-3">{report.excerpt}</blockquote>}<time className="text-xs text-muted-foreground" dateTime={report.createdAt.toISOString()}>{report.createdAt.toISOString()}</time><div className="flex flex-wrap items-center gap-3"><QuickAction label="Mark report reviewed" action={() => resolvePrivateReport(report.id)} /><Link className="text-sm underline" href="/app/admin?tab=users">Review account restrictions</Link></div></li>)}</ul>;
}
